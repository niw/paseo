import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FAKE_CLAUDE_CLI_SCRIPT } from "../agent/providers/claude/terminal/fake-claude-cli.fixture.js";
import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function timelineText(entries: ReadonlyArray<{ item: { type: string; text?: string } }>): string[] {
  return entries
    .filter(
      (entry) => entry.item.type === "user_message" || entry.item.type === "assistant_message",
    )
    .map((entry) => entry.item.text ?? "");
}

async function waitForReadyTerminal(
  client: DaemonClient,
  cwd: string,
): Promise<{ id: string; agentId?: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { terminals } = await client.listTerminals(cwd);
    const terminal = terminals.find((candidate) => candidate.name === "Claude");
    if (terminal?.activity) {
      return terminal;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Claude terminal");
}

describe.skipIf(process.platform === "win32")(
  "daemon E2E - a Claude (Terminal) agent driven from chat",
  () => {
    let tempRoot: string;
    let configDir: string;
    let cwd: string;
    let launchLog: string;
    let fakeClaude: string;
    let prevClaudeConfigDir: string | undefined;
    let daemon: TestPaseoDaemon | undefined;
    let client: DaemonClient | undefined;

    beforeEach(() => {
      tempRoot = mkdtempSync(path.join(tmpdir(), "claude-terminal-agent-e2e-"));
      configDir = path.join(tempRoot, "claude-config");
      cwd = path.join(tempRoot, "repo");
      launchLog = path.join(tempRoot, "launches.jsonl");
      fakeClaude = path.join(tempRoot, "fake-claude.cjs");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(fakeClaude, FAKE_CLAUDE_CLI_SCRIPT);
      writeFileSync(launchLog, "");
      prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = configDir;
    });

    afterEach(async () => {
      await client?.close().catch(() => undefined);
      await daemon?.close().catch(() => undefined);
      client = undefined;
      daemon = undefined;
      rmSync(tempRoot, { recursive: true, force: true });
      if (prevClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
      }
    }, 60_000);

    test("runs a prompt through Claude Code in a workspace terminal", async () => {
      daemon = await createTestPaseoDaemon({
        providerOverrides: {
          "claude-terminal": {
            enabled: true,
            command: [process.execPath, fakeClaude],
            env: {
              FAKE_CLAUDE_LAUNCH_LOG: launchLog,
              FAKE_CLAUDE_PROJECT_DIR: claudeProjectDirSync(cwd, { configDir }),
            },
          },
        },
      });
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });

      const agent = await client.createAgent({ provider: "claude-terminal", cwd });

      await client.sendMessage(agent.id, "Hello from chat");
      const finished = await client.waitForFinish(agent.id, 30_000);
      expect(finished.status).toBe("idle");
      const [launchArgs = []] = readFileSync(launchLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      expect(launchArgs).toContain("--session-id");
      const mcpConfigPath = launchArgs[launchArgs.indexOf("--mcp-config") + 1] ?? "";
      const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as {
        mcpServers: Record<string, { type: string; url: string }>;
      };
      expect(mcpConfig.mcpServers.paseo).toMatchObject({ type: "http" });
      expect(new URL(mcpConfig.mcpServers.paseo?.url ?? "").searchParams.get("callerAgentId")).toBe(
        agent.id,
      );

      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      expect(timelineText(timeline.entries)).toEqual([
        "Hello from chat",
        "Reply to Hello from chat",
      ]);
    }, 60_000);

    test("rebuilds the timeline after a rewind in Claude Code", async () => {
      daemon = await createTestPaseoDaemon({
        providerOverrides: {
          "claude-terminal": {
            enabled: true,
            command: [process.execPath, fakeClaude],
            env: {
              FAKE_CLAUDE_LAUNCH_LOG: launchLog,
              FAKE_CLAUDE_PROJECT_DIR: claudeProjectDirSync(cwd, { configDir }),
            },
          },
        },
      });
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const agent = await client.createAgent({ provider: "claude-terminal", cwd });
      for (const prompt of ["First", "Second"]) {
        await client.sendMessage(agent.id, prompt);
        expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");
      }

      const terminal = await waitForReadyTerminal(client, cwd);
      client.sendTerminalInput(terminal.id, { type: "input", data: "\x1b\x1b\r\r" });
      await client.sendMessage(agent.id, "Third");
      expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");

      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      expect(timelineText(timeline.entries)).toEqual([
        "First",
        "Reply to First",
        "Third",
        "Reply to Third",
      ]);
    }, 60_000);

    test("folds a steer from chat into the running turn", async () => {
      daemon = await createTestPaseoDaemon({
        providerOverrides: {
          "claude-terminal": {
            enabled: true,
            command: [process.execPath, fakeClaude],
            env: {
              FAKE_CLAUDE_LAUNCH_LOG: launchLog,
              FAKE_CLAUDE_PROJECT_DIR: claudeProjectDirSync(cwd, { configDir }),
              FAKE_CLAUDE_REPLY_DELAY_MS: "1500",
            },
          },
        },
      });
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });

      const agent = await client.createAgent({ provider: "claude-terminal", cwd });
      await client.sendMessage(agent.id, "First");
      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "running",
        15_000,
      );
      await client.sendMessage(agent.id, "Second", { activeTurnBehavior: "steer" });
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 15_000);

      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      expect(timelineText(timeline.entries)).toEqual([
        "First",
        "Second",
        "Reply to First",
        "Reply to Second",
      ]);
    }, 60_000);

    test("shows a prompt typed in the terminal as a running turn", async () => {
      daemon = await createTestPaseoDaemon({
        providerOverrides: {
          "claude-terminal": {
            enabled: true,
            command: [process.execPath, fakeClaude],
            env: {
              FAKE_CLAUDE_LAUNCH_LOG: launchLog,
              FAKE_CLAUDE_PROJECT_DIR: claudeProjectDirSync(cwd, { configDir }),
            },
          },
        },
      });
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });

      const agent = await client.createAgent({ provider: "claude-terminal", cwd });
      const terminal = await waitForReadyTerminal(client, cwd);
      expect(terminal.agentId).toBe(agent.id);

      client.sendTerminalInput(terminal.id, {
        type: "input",
        data: "\x1b[200~Typed here\x1b[201~\r",
      });
      await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "running",
        15_000,
      );
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 15_000);

      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      expect(timelineText(timeline.entries)).toEqual(["Typed here", "Reply to Typed here"]);
    }, 60_000);
  },
);
