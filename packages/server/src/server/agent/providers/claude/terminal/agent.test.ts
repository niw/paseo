import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import {
  createTerminalManager,
  type TerminalManager,
} from "../../../../../terminal/terminal-manager.js";
import { claudeProjectDirSync } from "../project-dir.js";
import { FAKE_CLAUDE_CLI_SCRIPT } from "./fake-claude-cli.fixture.js";
import { ClaudeTerminalAgentClient, type ClaudeTerminalAgentSession } from "./agent.js";

function describeTimeline(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "usage_updated") {
      return [];
    }
    if (event.type !== "timeline") {
      return [event.type];
    }
    const item = event.item as { type: string; text?: string };
    return item.type === "user_message" || item.type === "assistant_message"
      ? [`${item.type}:${item.text ?? ""}`]
      : [];
  });
}

function subagentEvents(events: AgentStreamEvent[]): ProviderSubagentInputEvent[] {
  return events.flatMap((event) => (event.type === "provider_subagent" ? [event.event] : []));
}

function hasRunningSubagent(events: AgentStreamEvent[]): boolean {
  return subagentEvents(events).some(
    (event) => event.type === "upsert" && event.status === "running",
  );
}

function subagentStatuses(events: AgentStreamEvent[]): string[] {
  return subagentEvents(events).flatMap((event) =>
    event.type === "upsert" && event.status ? [event.status] : [],
  );
}

function subagentReplies(events: AgentStreamEvent[]): string[] {
  return subagentEvents(events).flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
}

function notices(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "notification" ? [event.item.message] : [],
  );
}

function countEvents(events: AgentStreamEvent[], type: AgentStreamEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function hasEvent(events: AgentStreamEvent[], type: AgentStreamEvent["type"]): boolean {
  return countEvents(events, type) > 0;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.platform === "win32")("ClaudeTerminalAgentClient", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  let launchLog: string;
  let terminalManager: TerminalManager;
  let client: ClaudeTerminalAgentClient;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-terminal-agent-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    launchLog = path.join(tempRoot, "launches.jsonl");
    mkdirSync(cwd, { recursive: true });
    const fakeClaude = path.join(tempRoot, "fake-claude.cjs");
    writeFileSync(fakeClaude, FAKE_CLAUDE_CLI_SCRIPT);
    writeFileSync(launchLog, "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    terminalManager = createTerminalManager();
    client = new ClaudeTerminalAgentClient({
      logger: pino({ level: "silent" }),
      terminalManager,
      runtimeSettings: {
        command: { mode: "replace", argv: [process.execPath, fakeClaude] },
        env: {
          FAKE_CLAUDE_LAUNCH_LOG: launchLog,
          FAKE_CLAUDE_PROJECT_DIR: claudeProjectDirSync(cwd, { configDir }),
        },
      },
    });
  });

  afterEach(() => {
    terminalManager.killAll();
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function launchArgs(): string[][] {
    return readFileSync(launchLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  }

  /** The arguments of each launch, without its --settings. */
  function launches(): string[][] {
    return launchArgs().map((args) => {
      const index = args.indexOf("--settings");
      return index === -1 ? args : args.toSpliced(index, 2);
    });
  }

  function launchSettings(): Array<Record<string, unknown>> {
    return launchArgs().map((args) => {
      const index = args.indexOf("--settings");
      return index === -1 ? {} : (JSON.parse(args[index + 1]) as Record<string, unknown>);
    });
  }

  async function createSession(env?: Record<string, string>): Promise<ClaudeTerminalAgentSession> {
    return (await client.createSession(
      { provider: "claude-terminal", cwd, model: "opus", modeId: "acceptEdits" },
      { workspaceId: "ws-test", agentId: "agent-1", ...(env ? { env } : {}) },
    )) as ClaudeTerminalAgentSession;
  }

  async function waitForReady(session: ClaudeTerminalAgentSession): Promise<void> {
    await waitFor(() => session.getTerminal()?.getActivity() != null);
  }

  test("starts Claude Code in a workspace terminal with the session settings", async () => {
    const session = await createSession();
    await waitForReady(session);

    const terminal = session.getTerminal();
    expect(terminal?.workspaceId).toBe("ws-test");
    expect(terminal?.agentId).toBe("agent-1");
    expect(launches()).toEqual([
      ["--session-id", session.id, "--model", "opus", "--permission-mode", "acceptEdits"],
    ]);
    expect(launchSettings()[0]).toMatchObject({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "http" }] }] },
    });
    await session.close();
    expect(terminalManager.getTerminal(terminal?.id ?? "")).toBeUndefined();
  });

  test("hands Claude Code its MCP servers in a private config file", async () => {
    const paseoServer = {
      type: "http" as const,
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: "Bearer secret-token" },
    };
    const docsServer = { type: "stdio" as const, command: "docs-mcp", args: ["--serve"] };
    const session = (await client.createSession(
      { provider: "claude-terminal", cwd, mcpServers: { paseo: paseoServer, docs: docsServer } },
      { workspaceId: "ws-test" },
    )) as ClaudeTerminalAgentSession;
    await waitForReady(session);

    const args = launchArgs()[0] ?? [];
    expect(args.join(" ")).not.toContain("secret-token");
    const configPath = args[args.indexOf("--mcp-config") + 1] ?? "";
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      mcpServers: { paseo: paseoServer, docs: docsServer },
    });
    expect(session.describePersistence().metadata?.mcpServers).toEqual({ docs: docsServer });

    await session.close();
    expect(existsSync(configPath)).toBe(false);
  });

  test("lists the curated models and the ones settings.json names", async () => {
    const catalog = await client.fetchCatalog({ cwd, force: true });
    const modelIds = catalog.models.map((model) => model.id);
    expect(modelIds).toContain("claude-opus-5-5");
    expect(modelIds).not.toContain("claude-mythos-5-1");

    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ model: "claude-mythos-5-1" }),
    );
    const withSettings = await client.fetchCatalog({ cwd, force: true });
    expect(withSettings.models.map((model) => model.id)).toContain("claude-mythos-5-1");
    expect(launches()).toEqual([]);
  });

  test("lists draft commands without starting Claude Code", async () => {
    const commands = await client.listCommands({ provider: "claude-terminal", cwd });
    expect(commands.map((command) => command.name)).toEqual(["clear", "compact"]);
    expect(launches()).toEqual([]);
  });

  test("lists draft features without starting Claude Code", async () => {
    await expect(client.listFeatures()).resolves.toEqual([]);
    expect(launches()).toEqual([]);
    expect(terminalManager.listDirectories()).toEqual([]);
  });

  test("pastes a prompt into the terminal and follows the turn", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const { turnId } = await session.startTurn("Hello there");
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(describeTimeline(events)).toEqual([
      "turn_started",
      "user_message:Hello there",
      "assistant_message:Reply to Hello there",
      "turn_completed",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", turnId });
    await session.close();
  });

  test("reports the token usage the transcript records", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("Hello there");
    await waitFor(() => hasEvent(events, "turn_completed"));

    const contextUsage = {
      contextWindowUsedTokens: 115,
      contextWindowMaxTokens: expect.any(Number),
    };
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage_updated", usage: contextUsage }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "turn_completed",
      usage: { inputTokens: 10, cachedInputTokens: 100, outputTokens: 5, ...contextUsage },
    });
    expect(session.usageSession()).toMatchObject({ provider: "claude", model: "opus" });
    await session.close();
    expect(session.usageSession()).toBeNull();
  });

  test("follows a subagent's transcript as it runs", async () => {
    const session = await createSession({ FAKE_CLAUDE_REPLY_DELAY_MS: "2500" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("Use a subagent");
    await waitFor(() => hasRunningSubagent(events));
    expect(subagentStatuses(events)).not.toContain("completed");
    await waitFor(() => hasEvent(events, "turn_completed"));

    const upserts = subagentEvents(events).filter((event) => event.type === "upsert");
    expect(upserts[0]).toMatchObject({
      id: "toolu_1",
      toolCallId: "toolu_1",
      title: "general-purpose",
    });
    expect(upserts.at(-1)).toMatchObject({ id: "toolu_1", status: "completed" });
    expect(subagentReplies(events)).toEqual(["Subagent working", "Subagent done"]);
    await session.close();
  });

  test("waits until Claude Code is ready before it pastes a prompt", async () => {
    const session = await createSession({ FAKE_CLAUDE_READY_DELAY_MS: "500" });
    expect(session.getTerminal()?.getActivity()).toBeNull();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("Hello there");
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(describeTimeline(events)).toEqual([
      "turn_started",
      "user_message:Hello there",
      "assistant_message:Reply to Hello there",
      "turn_completed",
    ]);
    await session.close();
  });

  test("follows a turn started from a prompt typed in the terminal", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await waitForReady(session);
    session.getTerminal()?.send({ type: "input", data: "\x1b[200~Typed here\x1b[201~\r" });
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(describeTimeline(events)).toEqual([
      "turn_started",
      "user_message:Typed here",
      "assistant_message:Reply to Typed here",
      "turn_completed",
    ]);
    expect(events.some((event) => "turnId" in event && event.turnId)).toBe(false);

    const { turnId } = await session.startTurn("From chat");
    await waitFor(() => countEvents(events, "turn_completed") === 2);
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", turnId });
    await session.close();
  });

  test("folds a prompt sent during a turn into that turn", async () => {
    const session = await createSession({ FAKE_CLAUDE_REPLY_DELAY_MS: "1000" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const { turnId } = await session.startTurn("First");
    await waitFor(() => describeTimeline(events).includes("user_message:First"));
    await expect(
      session.steerActiveTurn("Second", { expectedTurnId: turnId, clientMessageId: "steer-1" }),
    ).resolves.toEqual({ status: "accepted" });
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(describeTimeline(events)).toEqual([
      "turn_started",
      "user_message:First",
      "assistant_message:Reply to First",
      "user_message:Second",
      "assistant_message:Reply to Second",
      "turn_completed",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ text: "Second", clientMessageId: "steer-1" }),
      }),
    );
    await session.close();
  });

  test("leaves a slash command sent during a turn to interrupt and replace", async () => {
    const session = await createSession();
    const { turnId } = await session.startTurn("Do something slow");

    await expect(session.steerActiveTurn("/compact", { expectedTurnId: turnId })).resolves.toEqual({
      status: "unavailable",
    });
    await session.close();
  });

  test("discards a queued prompt and the stopped prompt when it interrupts", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const { turnId } = await session.startTurn("Do something slow");
    await session.steerActiveTurn("Never run this", { expectedTurnId: turnId });
    await session.interrupt();
    expect(events.at(-1)).toMatchObject({ type: "turn_canceled", reason: "Interrupted" });

    await session.startTurn("Next");
    await waitFor(() => countEvents(events, "turn_completed") === 1);
    expect(describeTimeline(events).slice(-4)).toEqual([
      "turn_started",
      "user_message:Next",
      "assistant_message:Reply to Next",
      "turn_completed",
    ]);
    expect(describeTimeline(events)).not.toContain("user_message:Never run this");
    await session.close();
  });

  test("interrupts a running turn with Escape", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("Do something slow");
    await waitFor(() => describeTimeline(events).includes("user_message:Do something slow"));
    await session.interrupt();

    expect(events.at(-1)).toMatchObject({ type: "turn_canceled", reason: "Interrupted" });
    await session.close();
  });

  test("restarts Claude Code with the model and effort flags it switches to", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("First question");
    await waitFor(() => hasEvent(events, "turn_completed"));
    const firstTerminal = session.getTerminal();

    await session.setModel("sonnet");
    await waitForReady(session);
    await expect(session.setThinkingOption("low")).resolves.toBeUndefined();
    await waitForReady(session);

    expect(terminalManager.getTerminal(firstTerminal?.id ?? "")).toBeUndefined();
    expect(launches().slice(1)).toEqual([
      ["--resume", session.id, "--model", "sonnet", "--permission-mode", "acceptEdits"],
      [
        "--resume",
        session.id,
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--permission-mode",
        "acceptEdits",
      ],
    ]);
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      model: "sonnet",
      thinkingOptionId: "low",
    });

    await session.startTurn("Second question");
    await waitFor(() => countEvents(events, "turn_completed") === 2);
    expect(describeTimeline(events).at(-2)).toBe("assistant_message:Reply to Second question");
    await session.close();
  });

  test("restarts Claude Code for a new effort once the running turn ends", async () => {
    const session = await createSession({ FAKE_CLAUDE_REPLY_DELAY_MS: "1000" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("First question");
    await waitFor(() => hasEvent(events, "timeline"));

    await expect(session.setThinkingOption("ultracode")).resolves.toMatchObject({
      message: "Thinking level applies next turn",
    });
    expect(launches()).toHaveLength(1);

    await waitFor(() => hasEvent(events, "turn_completed"));
    expect(describeTimeline(events).at(-2)).toBe("assistant_message:Reply to First question");
    await waitFor(() => launches().length === 2);
    expect(launches()[1]).toEqual([
      "--resume",
      session.id,
      "--model",
      "opus",
      "--effort",
      "xhigh",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(launchSettings()[1]).toMatchObject({ ultracode: true });
    await session.close();
  });

  test("restarts Claude Code in the mode Paseo switches to", async () => {
    const session = await createSession();
    await waitForReady(session);

    await expect(session.setMode("plan")).resolves.toBeUndefined();
    await waitForReady(session);

    expect(launches().at(-1)).toEqual([
      "--session-id",
      session.id,
      "--model",
      "opus",
      "--permission-mode",
      "plan",
    ]);
    await expect(session.getCurrentMode()).resolves.toBe("plan");
    await expect(session.setMode("whatever")).rejects.toThrow("Unknown Claude mode");
    await session.close();
  });

  test("follows a mode the user switches to in the terminal", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await waitForReady(session);

    session.getTerminal()?.send({ type: "input", data: "\x1b[Z" });
    await session.startTurn("Hello");
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(events).toContainEqual(
      expect.objectContaining({ type: "mode_changed", currentModeId: "plan" }),
    );
    await expect(session.getCurrentMode()).resolves.toBe("plan");
    expect(session.describePersistence().metadata).toMatchObject({ modeId: "plan" });
    expect(launches()).toHaveLength(1);
    await session.close();
  });

  test("applies a mode switched during a turn once the turn ends", async () => {
    const session = await createSession({ FAKE_CLAUDE_REPLY_DELAY_MS: "1000" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("Hello");
    await waitFor(() => hasEvent(events, "timeline"));

    await expect(session.setMode("default")).resolves.toMatchObject({
      message: "Permission mode applies next turn",
    });
    await waitFor(() => hasEvent(events, "turn_completed"));
    await waitFor(() => launches().length === 2);

    expect(hasEvent(events, "mode_changed")).toBe(false);
    expect(launches()[1]).toContain("default");
    await expect(session.getCurrentMode()).resolves.toBe("default");
    await session.close();
  });

  async function requestPermission(
    session: ClaudeTerminalAgentSession,
    events: AgentStreamEvent[],
  ): Promise<{ turnId: string; requestId: string }> {
    const { turnId } = await session.startTurn("Needs permission");
    await waitFor(() => hasEvent(events, "permission_requested"));
    await waitFor(() => session.getTerminal()?.getActivity()?.attentionReason === "needs_input");
    const [request] = session.getPendingPermissions();
    return { turnId, requestId: request?.id ?? "" };
  }

  function permissionResolutions(events: AgentStreamEvent[]): unknown[] {
    return events.flatMap((event) =>
      event.type === "permission_resolved" ? [event.resolution] : [],
    );
  }

  test("asks for permission in Paseo and answers Claude Code with the decision", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { requestId } = await requestPermission(session, events);

    expect(session.getPendingPermissions()).toEqual([
      expect.objectContaining({
        id: requestId,
        provider: "claude-terminal",
        name: "Bash",
        kind: "tool",
        input: { command: "touch permission.txt" },
        metadata: { toolUseId: "toolu_1" },
        suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      }),
    ]);
    await session.respondToPermission(requestId, { behavior: "allow" });
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(session.getPendingPermissions()).toEqual([]);
    expect(permissionResolutions(events)).toEqual([{ behavior: "allow" }]);
    expect(hasEvent(events, "attention_required")).toBe(false);
    expect(describeTimeline(events)).toContain(
      'assistant_message:Allowed {"command":"touch permission.txt"}',
    );
    await session.close();
  });

  test("tells Claude Code why Paseo denied a permission", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { requestId } = await requestPermission(session, events);

    await session.respondToPermission(requestId, { behavior: "deny", message: "Not now" });
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(describeTimeline(events)).toContain("assistant_message:Denied: Not now");
    await session.close();
  });

  test("keeps a permission pending when the user views the agent", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { requestId } = await requestPermission(session, events);

    session.getTerminal()?.clearActivityAttention();

    expect(session.getPendingPermissions()).toEqual([expect.objectContaining({ id: requestId })]);
    await session.respondToPermission(requestId, { behavior: "allow" });
    await waitFor(() => hasEvent(events, "turn_completed"));
    expect(permissionResolutions(events)).toEqual([{ behavior: "allow" }]);
    await session.close();
  });

  test("settles a permission the user answers in the terminal", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await requestPermission(session, events);

    session.getTerminal()?.send({ type: "input", data: "\r" });
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(session.getPendingPermissions()).toEqual([]);
    expect(permissionResolutions(events)).toEqual([{ behavior: "allow" }]);
    expect(describeTimeline(events)).toContain("assistant_message:Allowed {}");
    await session.close();
  });

  test("denies a pending permission before it pastes a steer", async () => {
    const session = await createSession({ FAKE_CLAUDE_REPLY_DELAY_MS: "1000" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { turnId } = await requestPermission(session, events);

    await expect(
      session.steerActiveTurn("Do this instead", { expectedTurnId: turnId }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      session.steerActiveTurn("Do this instead", {
        expectedTurnId: turnId,
        clearPendingPermissions: true,
      }),
    ).resolves.toEqual({ status: "accepted" });
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(describeTimeline(events)).toEqual([
      "turn_started",
      "user_message:Needs permission",
      "permission_requested",
      "permission_resolved",
      expect.stringMatching(/^assistant_message:Denied: The user answered with a message/),
      "assistant_message:Reply to Needs permission",
      "user_message:Do this instead",
      "assistant_message:Reply to Do this instead",
      "turn_completed",
    ]);
    await session.close();
  });

  test("denies a pending permission when it interrupts the turn", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await requestPermission(session, events);

    await session.interrupt();

    expect(session.getPendingPermissions()).toEqual([]);
    expect(events.at(-1)?.type).toBe("turn_canceled");
    expect(describeTimeline(events)).toContain(
      "assistant_message:Denied: Permission request canceled",
    );
    await session.close();
  });

  test("follows the new session Claude Code starts on /clear", async () => {
    const session = await createSession();
    const firstSessionId = session.id;
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("Before clear");
    await waitFor(() => hasEvent(events, "turn_completed"));

    session.getTerminal()?.send({ type: "input", data: "\x1b[200~/clear\x1b[201~\r" });
    await session.startTurn("After clear");
    await waitFor(() => countEvents(events, "turn_completed") === 2);

    expect(session.id).not.toBe(firstSessionId);
    expect(events).toContainEqual({
      type: "thread_started",
      provider: "claude-terminal",
      sessionId: session.id,
    });
    expect(describeTimeline(events).slice(-3)).toEqual([
      "user_message:After clear",
      "assistant_message:Reply to After clear",
      "turn_completed",
    ]);
    const handle = session.describePersistence();
    expect(handle.sessionId).toBe(session.id);
    await session.close();

    const resumed = (await client.resumeSession(handle, undefined, {
      workspaceId: "ws-test",
    })) as ClaudeTerminalAgentSession;
    const history: AgentStreamEvent[] = [];
    for await (const event of resumed.streamHistory()) history.push(event);
    expect(describeTimeline(history)).toEqual([
      "user_message:After clear",
      "assistant_message:Reply to After clear",
    ]);
    await resumed.close();
  });

  test("offers the history again after a rewind in Claude Code", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("First");
    await waitFor(() => countEvents(events, "turn_completed") === 1);
    await session.startTurn("Second");
    await waitFor(() => countEvents(events, "turn_completed") === 2);

    session.getTerminal()?.send({ type: "input", data: "\x1b\x1b\r\r" });
    await session.startTurn("Third", { clientMessageId: "third-1" });
    await waitFor(() => countEvents(events, "turn_completed") === 3);

    expect(hasEvent(events, "history_reset")).toBe(true);
    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) history.push(event);
    expect(describeTimeline(history)).toEqual([
      "user_message:First",
      "assistant_message:Reply to First",
      "user_message:Third",
      "assistant_message:Reply to Third",
    ]);
    expect(history).toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({ text: "Third", clientMessageId: "third-1" }),
      }),
    );
    await session.close();
  });

  test("refuses prompts while Claude Code waits in its terminal", async () => {
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { turnId } = await session.startTurn("Open a dialog");
    await waitFor(() => notices(events).length > 0);

    expect(notices(events)).toEqual([
      "Claude Code is waiting for you in its terminal: choose: retry or edit",
    ]);
    expect(events.filter((event) => event.type === "attention_required")).toEqual([
      expect.objectContaining({
        reason: "permission",
        message: "Claude Code is waiting for you in its terminal: choose: retry or edit",
      }),
    ]);
    await expect(session.steerActiveTurn("Next", { expectedTurnId: turnId })).rejects.toThrow(
      "Claude Code is waiting for you in its terminal: choose: retry or edit",
    );

    session.getTerminal()?.send({ type: "input", data: "\r" });
    await waitFor(() => hasEvent(events, "turn_completed"));
    await session.startTurn("Afterwards");
    await waitFor(() => countEvents(events, "turn_completed") === 2);
    expect(describeTimeline(events)).toContain("assistant_message:Reply to Afterwards");
    await session.close();
  });

  test("resumes the session in a new terminal on the next prompt", async () => {
    const first = await createSession();
    const firstEvents: AgentStreamEvent[] = [];
    first.subscribe((event) => firstEvents.push(event));
    await first.startTurn("First question");
    await waitFor(() => hasEvent(firstEvents, "turn_completed"));
    const handle = first.describePersistence();
    await first.close();

    const resumed = (await client.resumeSession(handle, undefined, {
      workspaceId: "ws-test",
    })) as ClaudeTerminalAgentSession;
    const history: AgentStreamEvent[] = [];
    for await (const event of resumed.streamHistory()) history.push(event);
    expect(resumed.getTerminal()).toBeNull();
    expect(describeTimeline(history)).toEqual([
      "user_message:First question",
      "assistant_message:Reply to First question",
    ]);

    const events: AgentStreamEvent[] = [];
    resumed.subscribe((event) => events.push(event));
    await resumed.startTurn("Second question");
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(launches().at(-1)?.slice(0, 2)).toEqual(["--resume", handle.sessionId]);
    expect(describeTimeline(events)).toEqual([
      "turn_started",
      "user_message:Second question",
      "assistant_message:Reply to Second question",
      "turn_completed",
    ]);
    await resumed.close();
  });

  test("starts the terminal of a resumed session on request", async () => {
    const first = await createSession();
    const firstEvents: AgentStreamEvent[] = [];
    first.subscribe((event) => firstEvents.push(event));
    await first.startTurn("First question");
    await waitFor(() => hasEvent(firstEvents, "turn_completed"));
    const handle = first.describePersistence();
    await first.close();
    const launchCount = launches().length;

    const resumed = (await client.resumeSession(handle, undefined, {
      workspaceId: "ws-test",
    })) as ClaudeTerminalAgentSession;
    expect(resumed.getTerminal()).toBeNull();
    const terminal = await resumed.startTerminal();
    await waitFor(() => launches().length > launchCount);

    expect(resumed.getTerminal()).toBe(terminal);
    expect(launches().at(-1)?.slice(0, 2)).toEqual(["--resume", handle.sessionId]);
    await expect(resumed.startTerminal()).resolves.toBe(terminal);
    await resumed.close();
  });

  test("attaches images by pasting the paths of files it writes", async () => {
    const imageDirs = () =>
      readdirSync(os.tmpdir()).filter((name) => name.startsWith("paseo-claude-terminal-"));
    const imageDirsBefore = imageDirs();
    const session = await createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn(
      [
        { type: "text", text: "Describe this" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      { clientMessageId: "with-image" },
    );
    await waitFor(() => hasEvent(events, "turn_completed"));

    expect(describeTimeline(events)).toEqual([
      "turn_started",
      "user_message:[Image #1] Describe this",
      "assistant_message:Reply to [Image #1] Describe this",
      "turn_completed",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({ type: "user_message", clientMessageId: "with-image" }),
      }),
    );
    await session.close();
    expect(imageDirs()).toEqual(imageDirsBefore);
  });
});
