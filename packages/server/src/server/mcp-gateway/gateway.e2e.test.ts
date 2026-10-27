import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { loadMcpGatewayConfig } from "./config.js";
import { addMcpGatewayHost, listMcpGatewayHosts, removeMcpGatewayHost } from "./gateway.js";
import { createMcpGatewayHosts, type McpGatewayHosts } from "./hosts.js";
import {
  createMcpGatewayServer,
  type McpGatewayCaller,
  type McpGatewaySessionOptions,
} from "./tools.js";

const IDENTITY = { clientId: "mcp-gateway-test" };

let daemonA: TestPaseoDaemon;
let daemonB: TestPaseoDaemon;
let hosts: McpGatewayHosts;
let scratch: string;

beforeAll(async () => {
  [daemonA, daemonB] = await Promise.all([createTestPaseoDaemon(), createTestPaseoDaemon()]);
  hosts = createMcpGatewayHosts({
    hosts: [
      {
        serverId: daemonA.daemon.getServerId(),
        label: "a",
        connection: `127.0.0.1:${daemonA.port}`,
      },
      {
        serverId: daemonB.daemon.getServerId(),
        label: "b",
        connection: `127.0.0.1:${daemonB.port}`,
      },
    ],
    identity: IDENTITY,
  });
  scratch = await mkdtemp(path.join(os.tmpdir(), "paseo-mcp-gateway-e2e-"));
}, 60_000);

afterAll(async () => {
  await hosts?.close();
  await Promise.all([daemonA?.close(), daemonB?.close()]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function connect(
  caller: McpGatewayCaller | null,
  options?: McpGatewaySessionOptions,
): Promise<Client> {
  const server = createMcpGatewayServer({ hosts, caller, options });
  const client = new Client({ name: "gateway-e2e", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult & { structuredContent: Record<string, unknown> }> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult & {
    structuredContent: Record<string, unknown>;
  };
}

describe("MCP gateway", () => {
  it("acts on each configured daemon as an ordinary client", async () => {
    const client = await connect(null);
    try {
      const listed = await call(client, "list_hosts", {});
      expect(listed.structuredContent.hosts).toEqual([
        expect.objectContaining({ serverId: daemonA.daemon.getServerId(), label: "a" }),
        expect.objectContaining({ serverId: daemonB.daemon.getServerId(), label: "b" }),
      ]);

      const directory = path.join(scratch, "project-b");
      await mkdir(directory);
      const created = await call(client, "create_workspace", {
        serverId: daemonB.daemon.getServerId(),
        isolation: "local",
        path: directory,
        title: "Gateway workspace",
      });
      expect(created.isError).toBeFalsy();
      expect(created.structuredContent).toMatchObject({
        serverId: daemonB.daemon.getServerId(),
        title: "Gateway workspace",
      });

      const onB = await call(client, "list_workspaces", { serverId: daemonB.daemon.getServerId() });
      const onA = await call(client, "list_workspaces", { serverId: daemonA.daemon.getServerId() });
      expect(onB.structuredContent.workspaces).toEqual([
        expect.objectContaining({ workspaceId: created.structuredContent.workspaceId }),
      ]);
      expect(onA.structuredContent.workspaces).toEqual([]);
      expect((await hosts.list()).map((host) => host.status)).toEqual(["connected", "connected"]);
    } finally {
      await client.close();
    }
  });

  it("limits a caller to its permissions and hosts", async () => {
    const client = await connect({
      permissions: ["workspace.read"],
      hosts: [daemonB.daemon.getServerId()],
    });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(["list_hosts", "list_workspaces", "list_workspace_scripts"]),
      );
      for (const name of ["create_workspace", "start_workspace_script", "archive_workspace"]) {
        expect(names).not.toContain(name);
      }

      const listed = await call(client, "list_hosts", {});
      expect(listed.structuredContent.hosts).toEqual([
        expect.objectContaining({ serverId: daemonB.daemon.getServerId() }),
      ]);

      const hidden = await call(client, "list_workspaces", {
        serverId: daemonA.daemon.getServerId(),
      });
      const unknown = await call(client, "list_workspaces", { serverId: "server-z" });
      expect(hidden.isError).toBe(true);
      expect(hidden.structuredContent.error).toBe(
        `Unknown host ${daemonA.daemon.getServerId()}. Call list_hosts for available hosts.`,
      );
      expect(unknown.structuredContent.error).toBe(
        "Unknown host server-z. Call list_hosts for available hosts.",
      );
    } finally {
      await client.close();
    }
  });

  it("serves only the tools a session asks for, plus list_hosts", async () => {
    const client = await connect(null, { tools: ["list_workspaces", "archive_workspace"] });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "list_hosts",
        "list_workspaces",
        "archive_workspace",
      ]);
      const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
      expect(annotations.list_workspaces).toEqual({ readOnlyHint: true });
      expect(annotations.archive_workspace).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    } finally {
      await client.close();
    }
  });

  it("picks up hosts added and removed while it runs", async () => {
    const configPath = path.join(scratch, "reload", "mcp-gateway.json");
    await addMcpGatewayHost({ configPath, connection: `127.0.0.1:${daemonA.port}` });
    const reloading = createMcpGatewayHosts({
      hosts: (await loadMcpGatewayConfig(configPath)).hosts ?? [],
      identity: { clientId: "mcp-gateway-reload-test" },
      reload: async () => (await loadMcpGatewayConfig(configPath)).hosts ?? [],
    });
    const server = createMcpGatewayServer({ hosts: reloading, caller: null });
    const client = new Client({ name: "gateway-reload", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const serverA = daemonA.daemon.getServerId();
    const serverB = daemonB.daemon.getServerId();
    try {
      const before = await call(client, "list_workspaces", { serverId: serverB });
      expect(before.structuredContent.error).toBe(
        `Unknown host ${serverB}. Call list_hosts for available hosts.`,
      );

      // Added by another process after the gateway started.
      await addMcpGatewayHost({ configPath, connection: `127.0.0.1:${daemonB.port}` });
      const after = await call(client, "list_workspaces", { serverId: serverB });
      expect(after.isError).toBeFalsy();

      await call(client, "list_workspaces", { serverId: serverA });
      await removeMcpGatewayHost({ configPath, serverId: serverA });
      const listed = await call(client, "list_hosts", {});
      expect(listed.structuredContent.hosts).toEqual([
        expect.objectContaining({ serverId: serverB }),
      ]);
      const removed = await call(client, "list_workspaces", { serverId: serverA });
      expect(removed.isError).toBe(true);
    } finally {
      await client.close();
      await reloading.close();
    }
  });

  it("pins a host's server ID when it is added", async () => {
    const configPath = path.join(scratch, "mcp-gateway.json");
    const connection = `127.0.0.1:${daemonA.port}`;
    const added = await addMcpGatewayHost({
      configPath,
      connection,
      label: "work",
    });
    expect(added).toEqual({ serverId: daemonA.daemon.getServerId(), label: "work" });
    await expect(addMcpGatewayHost({ configPath, connection })).rejects.toThrow("already added");
    await expect(listMcpGatewayHosts(configPath)).resolves.toEqual([added]);
    await expect(
      removeMcpGatewayHost({ configPath, serverId: daemonA.daemon.getServerId() }),
    ).resolves.toEqual(added);
    await expect(listMcpGatewayHosts(configPath)).resolves.toEqual([]);
  });
});

describe("MCP gateway workspace tools", () => {
  it("renames a workspace, runs its scripts and archives it", async () => {
    const client = await connect(null);
    const serverId = daemonA.daemon.getServerId();
    try {
      const directory = path.join(scratch, "scripts-a");
      await mkdir(directory);
      await writeFile(
        path.join(directory, "paseo.json"),
        JSON.stringify({ scripts: { sleeper: { command: "sleep 30" } } }),
      );
      const workspace = await call(client, "create_workspace", {
        serverId,
        isolation: "local",
        path: directory,
      });
      const workspaceId = workspace.structuredContent.workspaceId as string;

      const projects = await call(client, "list_projects", { serverId });
      expect(projects.structuredContent.projects).toContainEqual(
        expect.objectContaining({ projectId: workspace.structuredContent.projectId }),
      );

      const renamed = await call(client, "rename_workspace", {
        serverId,
        workspaceId,
        title: "Scripts",
      });
      expect(renamed.structuredContent).toMatchObject({ success: true, title: "Scripts" });

      const scripts = await call(client, "list_workspace_scripts", { serverId, workspaceId });
      expect(scripts.structuredContent.scripts).toEqual([
        expect.objectContaining({ scriptName: "sleeper" }),
      ]);
      const started = await call(client, "start_workspace_script", {
        serverId,
        workspaceId,
        scriptName: "sleeper",
      });
      expect(started.isError).toBeFalsy();
      expect(started.structuredContent.script).toMatchObject({
        scriptName: "sleeper",
        lifecycle: "running",
      });
      const stopped = await call(client, "stop_workspace_script", {
        serverId,
        workspaceId,
        scriptName: "sleeper",
      });
      expect(stopped.isError).toBeFalsy();

      const archived = await call(client, "archive_workspace", { serverId, workspaceId });
      expect(archived.structuredContent.archivedAt).toEqual(expect.any(String));
      const listed = await call(client, "list_workspaces", { serverId });
      expect(listed.structuredContent.workspaces).not.toContainEqual(
        expect.objectContaining({ workspaceId }),
      );
    } finally {
      await client.close();
    }
  });
});

describe("MCP gateway exec mode", () => {
  function exec(client: Client, args: Record<string, unknown>) {
    return call(client, "paseo", args);
  }

  function text(result: CallToolResult): string {
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }

  it("serves the whole catalog through one tool", async () => {
    const client = await connect(null, { mode: "exec" });
    const serverId = daemonA.daemon.getServerId();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["paseo"]);

      const found = await exec(client, { command: "search", query: "proxy health" });
      expect(found.structuredContent.tools).toEqual([
        { name: "list_workspace_scripts", title: "List workspace scripts", effect: "read" },
      ]);
      const info = await exec(client, { command: "info", tool: "create_workspace" });
      expect(info.structuredContent).toMatchObject({
        name: "create_workspace",
        inputSchema: {
          type: "object",
          required: expect.arrayContaining(["serverId", "isolation", "path"]),
        },
      });

      const hostsResult = await exec(client, { command: "call", tool: "list_hosts" });
      expect(hostsResult.structuredContent.hosts).toHaveLength(2);
      const invalid = await exec(client, { command: "call", tool: "list_workspaces", args: {} });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toContain("Invalid args for list_workspaces");

      const directory = path.join(scratch, "exec-a");
      await mkdir(directory);
      const workspace = await exec(client, {
        command: "call",
        tool: "create_workspace",
        args: { serverId, isolation: "local", path: directory },
      });
      const workspaceId = workspace.structuredContent.workspaceId;
      const unconfirmed = await exec(client, {
        command: "call",
        tool: "archive_workspace",
        args: { serverId, workspaceId },
      });
      expect(unconfirmed.isError).toBe(true);
      expect(text(unconfirmed)).toContain("confirm: true");
      const confirmed = await exec(client, {
        command: "call",
        tool: "archive_workspace",
        args: { serverId, workspaceId },
        confirm: true,
      });
      expect(confirmed.structuredContent.archivedAt).toEqual(expect.any(String));
    } finally {
      await client.close();
    }
  });

  it("hides tools the caller may not use", async () => {
    const client = await connect(
      { permissions: ["workspace.read"], hosts: null },
      { mode: "exec" },
    );
    try {
      const listed = await exec(client, { command: "tools" });
      const names = (listed.structuredContent.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain("list_workspaces");
      expect(names).not.toContain("create_workspace");
      const denied = await exec(client, { command: "call", tool: "create_workspace", args: {} });
      expect(text(denied)).toBe("Unknown tool create_workspace. Use search or tools to find one.");
    } finally {
      await client.close();
    }
  });
});

describe("MCP gateway agent tools", () => {
  it.each([false, true])(
    "runs an agent, answers its permission request and archives it (background: %s)",
    async (background) => {
      const client = await connect(null);
      const serverId = daemonB.daemon.getServerId();
      try {
        const directory = path.join(scratch, `agents-b-${background}`);
        await mkdir(directory);
        const workspace = await call(client, "create_workspace", {
          serverId,
          isolation: "local",
          path: directory,
          background,
        });
        const created = await call(client, "create_agent", {
          serverId,
          workspaceId: workspace.structuredContent.workspaceId,
          provider: "claude/claude-test-model",
          title: "Gateway agent",
          initialPrompt: "say done and stop",
          settings: { modeId: "bypassPermissions" },
        });
        expect(created.isError).toBeFalsy();
        const agentId = created.structuredContent.agentId as string;
        const first = await call(client, "wait_for_agent", { serverId, agentId });
        expect(first.structuredContent).toMatchObject({ status: "idle", agentStatus: "idle" });

        const mode = await call(client, "set_agent_mode", { serverId, agentId, modeId: "default" });
        expect(mode.structuredContent).toMatchObject({ success: true, newMode: "default" });
        const sent = await call(client, "send_agent_prompt", {
          serverId,
          agentId,
          prompt: "rm -f permission.txt",
        });
        expect(sent.isError).toBeFalsy();
        const blocked = await call(client, "wait_for_agent", { serverId, agentId });
        expect(blocked.structuredContent.status).toBe("permission");

        const pending = await call(client, "list_pending_permissions", { serverId });
        const permissions = pending.structuredContent.permissions as Array<{
          agentId: string;
          request: { id: string; name: string };
        }>;
        expect(permissions).toEqual([
          expect.objectContaining({ agentId, request: expect.objectContaining({ name: "Bash" }) }),
        ]);
        const answered = await call(client, "respond_to_permission", {
          serverId,
          agentId,
          requestId: permissions[0]!.request.id,
          response: { behavior: "allow" },
        });
        expect(answered.structuredContent).toMatchObject({ success: true });
        const second = await call(client, "wait_for_agent", { serverId, agentId });
        expect(second.structuredContent).toMatchObject({ status: "idle", agentStatus: "idle" });

        const updated = await call(client, "update_agent", { serverId, agentId, name: "Renamed" });
        expect(updated.structuredContent).toMatchObject({ success: true });
        const status = await call(client, "get_agent_status", { serverId, agentId });
        expect(status.structuredContent.snapshot).toMatchObject({ title: "Renamed" });

        const before = await call(client, "list_agents", { serverId, includeBackground: true });
        expect(before.structuredContent.agents).toContainEqual(
          expect.objectContaining({ id: agentId, title: "Renamed" }),
        );
        const archived = await call(client, "archive_agent", { serverId, agentId });
        expect(archived.structuredContent).toMatchObject({ success: true });
        const listed = await call(client, "list_agents", { serverId, includeBackground: true });
        expect(listed.structuredContent.agents).not.toContainEqual(
          expect.objectContaining({ id: agentId }),
        );
      } finally {
        await client.close();
      }
    },
  );
});

describe("MCP gateway permission pagination", () => {
  it("finds pending permissions beyond the first page of agents", async () => {
    const client = await connect(null);
    const serverId = daemonB.daemon.getServerId();
    const directory = path.join(scratch, "permission-pages");
    await mkdir(directory);
    const workspace = await call(client, "create_workspace", {
      serverId,
      isolation: "local",
      path: directory,
      background: true,
    });
    const workspaceId = workspace.structuredContent.workspaceId as string;
    try {
      const created = await call(client, "create_agent", {
        serverId,
        workspaceId,
        provider: "claude/claude-test-model",
        title: "Waiting for permission",
        initialPrompt: "rm -f permission.txt",
        settings: { modeId: "default" },
      });
      expect(created.isError).toBeFalsy();
      const agentId = created.structuredContent.agentId as string;
      const blocked = await call(client, "wait_for_agent", { serverId, agentId });
      expect(blocked.structuredContent.status).toBe("permission");

      const firstPage = await hosts.use(serverId, async (host) => {
        for (let index = 0; index < 200; index++) {
          await host.createAgent({
            workspaceId,
            config: {
              provider: "claude",
              model: "claude-test-model",
              cwd: directory,
              title: `Idle agent ${index}`,
            },
          });
        }
        return host.fetchAgents({
          includeBackground: true,
          sort: [{ key: "created_at", direction: "desc" }],
          page: { limit: 200 },
        });
      });
      expect(firstPage.pageInfo.hasMore).toBe(true);
      expect(firstPage.entries.map(({ agent }) => agent.id)).not.toContain(agentId);

      const pending = await call(client, "list_pending_permissions", { serverId });
      expect(pending.structuredContent.permissions).toEqual([
        expect.objectContaining({ agentId, request: expect.objectContaining({ name: "Bash" }) }),
      ]);
    } finally {
      await call(client, "archive_workspace", { serverId, workspaceId });
      await client.close();
    }
  });
});

describe("MCP gateway terminal tools", () => {
  it("runs a command in a workspace terminal and reads its output", async () => {
    const client = await connect(null);
    const serverId = daemonA.daemon.getServerId();
    try {
      const directory = path.join(scratch, "terminal-a");
      await mkdir(directory);
      const workspace = await call(client, "create_workspace", {
        serverId,
        isolation: "local",
        path: directory,
      });
      const workspaceId = workspace.structuredContent.workspaceId as string;
      const created = await call(client, "create_terminal", { serverId, workspaceId, name: "gw" });
      expect(created.isError).toBeFalsy();
      expect(created.structuredContent).toMatchObject({ name: "gw", cwd: directory, workspaceId });
      const terminalId = created.structuredContent.id as string;

      const listed = await call(client, "list_terminals", { serverId, workspaceId });
      expect(listed.structuredContent.terminals).toEqual([
        expect.objectContaining({ id: terminalId }),
      ]);

      await call(client, "send_terminal_keys", {
        serverId,
        terminalId,
        keys: "echo gateway-$((40 + 2))",
        literal: true,
      });
      await call(client, "send_terminal_keys", { serverId, terminalId, keys: "Enter" });
      let lines: string[] = [];
      const deadline = Date.now() + 10_000;
      while (!lines.includes("gateway-42") && Date.now() < deadline) {
        const capture = await call(client, "capture_terminal", { serverId, terminalId });
        lines = (capture.structuredContent.lines as string[]).map((line) => line.trim());
        if (!lines.includes("gateway-42")) await new Promise((r) => setTimeout(r, 100));
      }
      expect(lines).toContain("gateway-42");

      const missing = await call(client, "send_terminal_keys", {
        serverId,
        terminalId: "missing",
        keys: "Enter",
      });
      expect(missing.isError).toBe(true);

      const killed = await call(client, "kill_terminal", { serverId, terminalId });
      expect(killed.structuredContent).toMatchObject({ success: true });
      const after = await call(client, "list_terminals", { serverId, workspaceId });
      expect(after.structuredContent.terminals).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("MCP gateway schedule tools", () => {
  it("creates, changes, pauses and deletes a schedule", async () => {
    const client = await connect(null);
    const serverId = daemonB.daemon.getServerId();
    try {
      const directory = path.join(scratch, "schedules-b");
      await mkdir(directory);
      const ambiguous = await call(client, "create_schedule", {
        serverId,
        prompt: "check in",
        cron: "0 9 * * *",
        agentId: "agent-1",
        provider: "claude",
        cwd: directory,
      });
      expect(ambiguous.isError).toBe(true);

      const created = await call(client, "create_schedule", {
        serverId,
        prompt: "check in",
        cron: "0 9 * * *",
        timezone: "UTC",
        name: "Morning",
        provider: "claude/claude-test-model",
        cwd: directory,
        expiresIn: "168h",
      });
      expect(created.isError).toBeFalsy();
      const id = created.structuredContent.id as string;
      expect(created.structuredContent).toMatchObject({ name: "Morning" });

      const listed = await call(client, "list_schedules", { serverId });
      expect(listed.structuredContent.schedules).toEqual([expect.objectContaining({ id })]);

      const updated = await call(client, "update_schedule", {
        serverId,
        id,
        name: "Evening",
        cron: "0 18 * * *",
      });
      expect(updated.structuredContent).toMatchObject({
        name: "Evening",
        cadence: { type: "cron", expression: "0 18 * * *" },
      });

      const paused = await call(client, "pause_schedule", { serverId, id });
      expect(paused.structuredContent).toMatchObject({ status: "paused" });
      const resumed = await call(client, "resume_schedule", { serverId, id });
      expect(resumed.structuredContent).toMatchObject({ status: "active" });
      const inspected = await call(client, "inspect_schedule", { serverId, id });
      expect(inspected.structuredContent).toMatchObject({
        id,
        target: { type: "new-agent", config: expect.objectContaining({ cwd: directory }) },
      });
      const logs = await call(client, "schedule_logs", { serverId, id });
      expect(logs.structuredContent.runs).toEqual([]);

      const deleted = await call(client, "delete_schedule", { serverId, id });
      expect(deleted.structuredContent).toMatchObject({ success: true, id });
      const after = await call(client, "list_schedules", { serverId });
      expect(after.structuredContent.schedules).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("MCP gateway provider tools", () => {
  it("reports a host's providers, models and profiles", async () => {
    const client = await connect(null);
    const serverId = daemonA.daemon.getServerId();
    try {
      const providers = await call(client, "list_providers", { serverId });
      expect(providers.structuredContent.providers).toContainEqual(
        expect.objectContaining({ id: "claude", enabled: true }),
      );
      const models = await call(client, "list_models", { serverId, provider: "claude" });
      expect(models.structuredContent.models).toContainEqual(
        expect.objectContaining({ id: "sonnet" }),
      );
      const inspected = await call(client, "inspect_provider", {
        serverId,
        provider: "claude/sonnet",
        cwd: scratch,
      });
      expect(inspected.isError).toBeFalsy();
      expect(inspected.structuredContent).toMatchObject({
        provider: "claude",
        selectedModel: "sonnet",
        features: expect.any(Array),
      });
      const profiles = await call(client, "list_profiles", { serverId });
      expect(profiles.structuredContent.profiles).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("MCP gateway checkout and file tools", () => {
  it("reads, commits and pushes a checkout's changes", async () => {
    const client = await connect(null);
    const serverId = daemonB.daemon.getServerId();
    const repo = path.join(scratch, "repo-b");
    const remote = path.join(scratch, "remote-b.git");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    try {
      await mkdir(repo);
      git(scratch, "init", "--bare", "-b", "main", remote);
      git(repo, "init", "-b", "main");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test");
      git(repo, "config", "commit.gpgsign", "false");
      await writeFile(path.join(repo, "hello.txt"), "hello\n");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "initial");
      git(repo, "remote", "add", "origin", remote);
      git(repo, "push", "-u", "origin", "main");
      await writeFile(path.join(repo, "hello.txt"), "hello\nworld\n");

      const listing = await call(client, "list_directory", { serverId, cwd: repo });
      expect(listing.structuredContent.entries).toContainEqual(
        expect.objectContaining({ name: "hello.txt", kind: "file" }),
      );
      const file = await call(client, "read_file", { serverId, cwd: repo, path: "hello.txt" });
      expect(file.structuredContent).toMatchObject({ kind: "text", content: "hello\nworld\n" });

      const dirty = await call(client, "get_checkout_status", { serverId, cwd: repo });
      expect(dirty.structuredContent).toMatchObject({
        isGit: true,
        currentBranch: "main",
        isDirty: true,
      });
      const diff = await call(client, "get_checkout_diff", { serverId, cwd: repo });
      expect(diff.structuredContent.files).toEqual([
        expect.objectContaining({
          path: "hello.txt",
          additions: 1,
          diff: expect.stringContaining("\n+world"),
        }),
      ]);

      const committed = await call(client, "commit_changes", {
        serverId,
        cwd: repo,
        message: "add world",
        addAll: true,
      });
      expect(committed.structuredContent).toMatchObject({ success: true });
      expect(git(repo, "log", "-1", "--format=%s")).toBe("add world");
      const pushed = await call(client, "push_changes", { serverId, cwd: repo });
      expect(pushed.structuredContent).toMatchObject({ success: true });
      expect(git(remote, "log", "-1", "--format=%s", "main")).toBe("add world");
      const clean = await call(client, "get_checkout_status", { serverId, cwd: repo });
      expect(clean.structuredContent).toMatchObject({ isDirty: false });
    } finally {
      await client.close();
    }
  });
});
