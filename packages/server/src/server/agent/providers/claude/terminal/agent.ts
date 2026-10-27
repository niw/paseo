import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import type { TerminalManager } from "../../../../../terminal/terminal-manager.js";
import type { TerminalSession } from "../../../../../terminal/terminal.js";
import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionUpdate,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProviderNotice,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentUsage,
  AgentUsageSession,
  FetchCatalogOptions,
  SteerActiveTurnOptions,
  SteerResult,
  ProviderCatalog,
  ProviderRefreshContext,
} from "../../../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import { renderPromptAttachmentAsText } from "../../../prompt-attachments.js";
import { stripInternalPaseoMcpServer } from "../../../runtime-mcp-config.js";
import { runProviderTurn } from "../../provider-runner.js";
import {
  MODE_APPLIES_NEXT_TURN_NOTICE,
  THINKING_APPLIES_NEXT_TURN_NOTICE,
} from "../../../provider-notices.js";
import {
  ClaudeAgentClient,
  DEFAULT_MODES as CLAUDE_MODES,
  STEER_SUPERSEDED_PERMISSION_MESSAGE,
  assertClaudeQuestionAnswerDeliverable,
  assertClaudeThinkingOptionSupported,
  isClaudeThinkingEffort,
  isClaudeThinkingOption,
  toClaudeSdkMcpConfig,
} from "../agent.js";
import {
  CLAUDE_DISABLED_THINKING_OPTION_ID,
  CLAUDE_ULTRACODE_THINKING_OPTION_ID,
  resolveClaudeDisabledThinkingForModel,
} from "../model-manifest.js";
import { claudeConfigDir, claudeTranscriptPathSync } from "../project-dir.js";
import {
  CLAUDE_HOOK_TOKEN_ENV,
  claudeHookSettings,
  type ClaudeHookEvent,
  type ClaudeHookInput,
  type ClaudeHookOutput,
  type ClaudeHookRegistration,
  ClaudeHookServer,
} from "./hook-server.js";
import { listClaudeTerminalCommands } from "./commands.js";
import {
  buildClaudePermissionRequest,
  normalizeClaudePermissionUpdates,
  resolveClaudeAllowedInput,
} from "./permission-request.js";
import { ClaudeTranscriptFollower } from "./transcript-follower.js";
import { ClaudeTranscriptUsage } from "./transcript-usage.js";
import { getClaudeContextWindowMaxTokens } from "../models.js";

export const CLAUDE_TERMINAL_PROVIDER = "claude-terminal";

const READY_TIMEOUT_MS = 30_000;
const TURN_START_GRACE_MS = 5_000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1000;
const TRANSCRIPT_SETTLE_TIMEOUT_MS = 2000;
const TRANSCRIPT_QUIET_MS = 600;
const ENTER_DELAY_MS = 50;
const IMAGE_PASTE_DELAY_MS = 300;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const ESCAPE = "\x1b";
const ARROW_UP = "\x1b[A";
const CTRL_C = "\x03";
const KEY_DELAY_MS = 150;
const PERMISSION_DIALOG_SETTLE_TIMEOUT_MS = 5_000;
// NOTE: Claude Code waits for a PermissionRequest hook while it shows its own dialog, so the
// hook may wait as long as the user takes to answer.
const CLAUDE_HOOK_EVENTS: readonly ClaudeHookEvent[] = [
  { name: "UserPromptSubmit" },
  { name: "PreToolUse" },
  { name: "PermissionRequest", timeoutSeconds: 24 * 60 * 60 },
  { name: "Stop" },
  { name: "Notification" },
];
// NOTE: Claude Code reports blocked a moment after the PermissionRequest hook it raises for the
// same dialog, so a blocked state waits this long for a request to explain it.
const TERMINAL_WAIT_GRACE_MS = 500;
const NOTIFICATION_RECENT_MS = 5_000;
const TERMINAL_DENIED_MESSAGE = "Declined in Claude Code's terminal";
const CANCELED_PERMISSION_MESSAGE = "Permission request canceled";

function isClaudeModeId(modeId: string): boolean {
  return CLAUDE_MODES.some((mode) => mode.id === modeId);
}

const CLAUDE_TERMINAL_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

export interface ClaudeTerminalAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  terminalManager?: TerminalManager;
  /** Converts transcripts and discovers models. Defaults to a ClaudeAgentClient. */
  claude?: ClaudeAgentClient;
}

interface PendingEcho {
  /** The trimmed prompt, which the transcript echoes. */
  text: string;
  /** Ties the prompt the manager recorded to its echo. */
  clientMessageId?: string;
  /** Submitted while a turn runs, so Claude Code queues it until the turn reads it. */
  steer: boolean;
}

interface PendingPermission {
  request: AgentPermissionRequest;
  /** Claude Code shows its dialog for the request, so leaving that state answers it there. */
  shown: boolean;
  /** Answers the PermissionRequest hook that waits for the user. */
  answer: (output: ClaudeHookOutput) => void;
}

interface ClaudeTerminalAgentSessionOptions {
  logger: Logger;
  terminalManager: TerminalManager;
  runtimeSettings?: ProviderRuntimeSettings;
  sessionId: string;
  config: AgentSessionConfig;
  launchContext?: AgentLaunchContext;
  transcript: ClaudeTranscriptFollower;
  resolveTranscriptPath: (sessionId: string) => string;
  /** Follows the transcript a new session writes, such as after /clear. */
  followNewTranscript: (sessionId: string) => ClaudeTranscriptFollower;
  hookServer: ClaudeHookServer;
}

interface TerminalPrompt {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
}

function splitPrompt(prompt: AgentPromptInput): TerminalPrompt {
  if (typeof prompt === "string") {
    return { text: prompt, images: [] };
  }
  const parts: string[] = [];
  const images: TerminalPrompt["images"] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image") {
      images.push({ data: block.data, mimeType: block.mimeType });
    } else {
      parts.push(renderPromptAttachmentAsText(block));
    }
  }
  return { text: parts.join("\n\n"), images };
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Claude Code shows each pasted image as an `[Image #N]` placeholder, which the transcript
// keeps in the prompt's text.
function normalizeEchoText(text: string): string {
  return text
    .replace(/\[Image #\d+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface ThinkingLaunch {
  effort?: string;
  settings: Record<string, unknown>;
}

// Without an option, Claude Code uses the user's own effort.
function thinkingLaunch(thinkingOptionId: string | undefined): ThinkingLaunch {
  if (thinkingOptionId === CLAUDE_DISABLED_THINKING_OPTION_ID) {
    return { settings: { alwaysThinkingEnabled: false } };
  }
  if (thinkingOptionId === CLAUDE_ULTRACODE_THINKING_OPTION_ID) {
    return { effort: "xhigh", settings: { ultracode: true } };
  }
  if (isClaudeThinkingEffort(thinkingOptionId)) {
    return { effort: thinkingOptionId, settings: {} };
  }
  return { settings: {} };
}

// NOTE: Settings passed with --settings apply to this session only and leave the config
// dir's settings.json alone. Claude Code reads one --settings, so they go in one object.
function configArgs(config: AgentSessionConfig, settings: Record<string, unknown>): string[] {
  const args: string[] = [];
  if (config.model) {
    args.push("--model", config.model);
  }
  const thinking = thinkingLaunch(config.thinkingOptionId);
  if (thinking.effort) {
    args.push("--effort", thinking.effort);
  }
  if (config.modeId && isClaudeModeId(config.modeId)) {
    args.push("--permission-mode", config.modeId);
  }
  const appendedSystemPrompt = [config.systemPrompt, config.daemonAppendSystemPrompt]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
  if (appendedSystemPrompt) {
    args.push("--append-system-prompt", appendedSystemPrompt);
  }
  const launchSettings = { ...thinking.settings, ...settings };
  if (Object.keys(launchSettings).length > 0) {
    args.push("--settings", JSON.stringify(launchSettings));
  }
  return args;
}

function paste(terminal: TerminalSession, text: string): void {
  terminal.send({ type: "input", data: `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` });
}

// NOTE: Claude Code attaches an image when a paste is just the path of an image file, and
// it reads the file before the next paste can join the prompt.
async function typePrompt(
  terminal: TerminalSession,
  text: string,
  imagePaths: string[],
): Promise<void> {
  for (const imagePath of imagePaths) {
    paste(terminal, imagePath);
    await new Promise((resolve) => setTimeout(resolve, IMAGE_PASTE_DELAY_MS));
  }
  if (text) {
    paste(terminal, imagePaths.length > 0 ? ` ${text}` : text);
  }
  await new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS));
  terminal.send({ type: "input", data: "\r" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAwaitingAnswer(activity: TerminalActivity | null): boolean {
  return activity?.attentionReason === "needs_input";
}

function toolCallKey(toolName: unknown, toolInput: unknown): string {
  return JSON.stringify([toolName, toolInput]);
}

/** The PermissionRequest hook output that answers Claude Code with the user's response. */
function permissionHookOutput(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): ClaudeHookOutput {
  let decision: Record<string, unknown>;
  if (response.behavior === "allow") {
    decision = {
      behavior: "allow",
      updatedInput: resolveClaudeAllowedInput(request, response),
      updatedPermissions: normalizeClaudePermissionUpdates(response.updatedPermissions),
    };
  } else {
    decision = {
      behavior: "deny",
      message: response.message ?? "Permission request denied",
      interrupt: response.interrupt,
    };
  }
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

function isWorking(activity: TerminalActivity | null): boolean {
  // NOTE: A blocked Claude Code asks the user in its own UI, so the turn stays open.
  return activity?.state === "working" || activity?.attentionReason === "needs_input";
}

/**
 * A Claude session that runs as the interactive Claude Code CLI in a Paseo terminal.
 * Prompts are pasted into the terminal, the conversation comes from the transcript,
 * and the turn state comes from the terminal's OSC 7501 program status.
 */
export class ClaudeTerminalAgentSession implements AgentSession {
  readonly provider = CLAUDE_TERMINAL_PROVIDER;
  readonly capabilities = CLAUDE_TERMINAL_CAPABILITIES;
  private readonly options: ClaudeTerminalAgentSessionOptions;
  private readonly logger: Logger;
  private sessionId: string;
  private transcript: ClaudeTranscriptFollower;
  private usage: ClaudeTranscriptUsage;
  private readonly usageSessionKey = randomUUID();
  private hooks: Promise<ClaudeHookRegistration | null> | null = null;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  /** Claude Code waits for the user in its terminal for something Paseo cannot answer. */
  private terminalWait: { message: string | null } | null = null;
  private terminalWaitTimer: ReturnType<typeof setTimeout> | null = null;
  /** The latest Notification hook, which can say what Claude Code waits for. */
  private lastNotification: { message: string; at: number } | null = null;
  /** Tool use IDs PreToolUse reported, by tool call. PermissionRequest carries none. */
  private readonly toolUseIds = new Map<string, string>();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private terminal: TerminalSession | null = null;
  private terminalSubscriptions: Array<() => void> = [];
  private spawning: Promise<TerminalSession> | null = null;
  private activeTurnId: string | null = null;
  /** The active turn began from a prompt typed in the terminal, so the manager owns its ID. */
  private turnStartedInTerminal = false;
  /** Prompts submitted to Claude Code whose echo the transcript has not shown yet. */
  private pendingEchoes: PendingEcho[] = [];
  /** The client message ID of each echo, by transcript message, for a history offered again. */
  private readonly echoedMessages = new Map<string, string>();
  /** Holds the files Claude Code reads by path, such as prompt images and the MCP config. */
  private fileDir: string | null = null;
  /** Settles once the keys sent so far reached the terminal. */
  private typing: Promise<void> = Promise.resolve();
  private turnWorking = false;
  private interruptRequested = false;
  /** The launch flags changed during a turn, so Claude Code restarts once it ends. */
  private relaunchPending = false;
  /** Settles once the Claude Code a restart stops has exited. */
  private stopping: Promise<void> = Promise.resolve();
  private turnStartTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: ClaudeTerminalAgentSessionOptions) {
    this.options = options;
    this.logger = options.logger.child({ claudeTerminalSessionId: options.sessionId });
    this.sessionId = options.sessionId;
    this.transcript = options.transcript;
    this.usage = new ClaudeTranscriptUsage(options.resolveTranscriptPath(options.sessionId));
  }

  get id(): string {
    return this.sessionId;
  }

  /** The terminal running Claude Code, started on demand. */
  getTerminal(): TerminalSession | null {
    return this.terminal;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (turnPrompt, turnOptions) => this.startTurn(turnPrompt, turnOptions),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.sessionId,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurnId) {
      throw new Error("A turn is already active");
    }
    this.assertNotWaitingInTerminal();
    const input = splitPrompt(prompt);
    const terminal = await this.readyTerminal();
    const imagePaths = await this.writeImages(input.images);
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.usage.beginTurn();
    this.turnWorking = false;
    this.interruptRequested = false;
    void this.submitPrompt(terminal, input.text, imagePaths, {
      clientMessageId: options?.clientMessageId,
      steer: false,
    });
    // A prompt Claude Code answers without working, such as some slash commands,
    // never reports working, so the turn ends once the grace period passes.
    this.turnStartTimer = setTimeout(() => {
      this.turnStartTimer = null;
      if (this.activeTurnId === turnId && !this.turnWorking) {
        void this.finishTurn();
      }
    }, TURN_START_GRACE_MS);
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    return { turnId };
  }

  // NOTE: Claude Code queues a prompt submitted while it works and folds it into the running
  // turn. A slash command does not join a turn, so it falls back to interrupt and replace.
  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    const terminal = this.terminal;
    const input = splitPrompt(prompt);
    if (
      !terminal ||
      !this.activeTurnId ||
      (!this.turnStartedInTerminal && options.expectedTurnId !== this.activeTurnId) ||
      input.text.trimStart().startsWith("/") ||
      (this.pendingPermissions.size > 0 && !options.clearPendingPermissions)
    ) {
      return { status: "unavailable" };
    }
    this.assertNotWaitingInTerminal();
    // NOTE: A paste while Claude Code shows a permission dialog would go into the dialog.
    if (this.pendingPermissions.size > 0) {
      this.denyPermissions({ behavior: "deny", message: STEER_SUPERSEDED_PERMISSION_MESSAGE });
      await this.waitForDialogToClose(terminal);
    }
    const imagePaths = await this.writeImages(input.images);
    await this.submitPrompt(terminal, input.text, imagePaths, {
      clientMessageId: options.clientMessageId,
      steer: true,
    });
    return { status: "accepted" };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  // A history offered again after a rewind can hold the echo of a prompt sent since.
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const event of this.transcript.takeHistory()) {
      yield event.type === "timeline" ? this.withEcho(event) : event;
    }
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return listClaudeTerminalCommands({
      configDir: claudeConfigDir({
        ...process.env,
        ...this.options.runtimeSettings?.env,
        ...this.options.launchContext?.env,
      }),
      cwd: this.options.config.cwd,
      transcriptPath: this.options.resolveTranscriptPath(this.sessionId),
    });
  }

  usageSession(): AgentUsageSession | null {
    if (this.closed) {
      return null;
    }
    return {
      provider: "claude",
      ...(this.options.config.model ? { model: this.options.config.model } : {}),
      env: { ...this.options.runtimeSettings?.env, ...this.options.launchContext?.env },
      sessionKey: this.usageSessionKey,
    };
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      model: this.options.config.model ?? null,
      thinkingOptionId: this.options.config.thinkingOptionId ?? null,
      modeId: this.options.config.modeId ?? null,
    };
  }

  async setModel(modelId: string | null): Promise<void> {
    const config = this.options.config;
    config.model = modelId?.trim() || undefined;
    if (config.thinkingOptionId === CLAUDE_DISABLED_THINKING_OPTION_ID) {
      const resolution = resolveClaudeDisabledThinkingForModel(config.model);
      if (!resolution.supported) {
        config.thinkingOptionId = resolution.fallbackThinkingOptionId;
        this.emit({
          type: "thinking_option_changed",
          provider: this.provider,
          thinkingOptionId: config.thinkingOptionId ?? null,
        });
      }
    }
    await this.relaunch();
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void | AgentProviderNotice> {
    const normalized = thinkingOptionId?.trim() || null;
    if (!normalized || normalized === "default") {
      this.options.config.thinkingOptionId = undefined;
    } else if (isClaudeThinkingOption(normalized)) {
      assertClaudeThinkingOptionSupported(this.options.config.model, normalized);
      this.options.config.thinkingOptionId = normalized;
    } else {
      throw new Error(`Unknown thinking option: ${normalized}`);
    }
    const deferred = this.activeTurnId !== null;
    await this.relaunch();
    if (deferred) {
      return THINKING_APPLIES_NEXT_TURN_NOTICE;
    }
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return CLAUDE_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.options.config.modeId ?? null;
  }

  async setMode(modeId: string): Promise<void | AgentProviderNotice> {
    if (!isClaudeModeId(modeId)) {
      throw new Error(`Unknown Claude mode: ${modeId}`);
    }
    if (modeId === this.options.config.modeId) {
      return;
    }
    this.options.config.modeId = modeId;
    const deferred = this.activeTurnId !== null;
    await this.relaunch();
    if (deferred) {
      return MODE_APPLIES_NEXT_TURN_NOTICE;
    }
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values(), (pending) => pending.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }
    assertClaudeQuestionAnswerDeliverable(pending.request, response);
    this.settlePermission(requestId, permissionHookOutput(pending.request, response), response);
  }

  describePersistence(): AgentPersistenceHandle {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      nativeHandle: this.sessionId,
      // The daemon injects its own MCP server, with a token, on every launch.
      metadata: { ...stripInternalPaseoMcpServer(this.options.config), provider: this.provider },
    };
  }

  // NOTE: Escape makes Claude Code run the prompts queued during the turn right away, so
  // Up first moves unread steers into the input. Ctrl-C then clears the input, which also
  // holds the stopped prompt when the interrupt comes before any reply. A second Ctrl-C
  // within a few seconds exits Claude Code, so it is sent once.
  async interrupt(): Promise<void> {
    const terminal = this.terminal;
    if (!terminal || !this.activeTurnId) {
      return;
    }
    this.interruptRequested = true;
    this.denyPermissions({
      behavior: "deny",
      message: CANCELED_PERMISSION_MESSAGE,
      interrupt: true,
    });
    await this.typing;
    await this.refreshTimeline();
    if (this.pendingEchoes.some((pending) => pending.steer)) {
      terminal.send({ type: "input", data: ARROW_UP });
      await new Promise((resolve) => setTimeout(resolve, KEY_DELAY_MS));
    }
    terminal.send({ type: "input", data: ESCAPE });
    const deadline = Date.now() + INTERRUPT_SETTLE_TIMEOUT_MS;
    while (this.activeTurnId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.activeTurnId) {
      throw new Error("Claude Code did not stop the turn");
    }
    this.pendingEchoes = [];
    if (this.terminal === terminal) {
      terminal.send({ type: "input", data: CTRL_C });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopPolling();
    this.clearTurnStartTimer();
    const terminal = this.terminal;
    this.detachTerminal();
    if (terminal) {
      this.options.terminalManager.killTerminal(terminal.id);
    }
    this.cancelPermissions();
    this.subscribers.clear();
    const hooks = await this.hooks;
    hooks?.unregister();
    if (this.fileDir) {
      await rm(this.fileDir, { recursive: true, force: true });
      this.fileDir = null;
    }
  }

  /** Starts Claude Code in a new terminal unless one runs. A transcript makes it resume. */
  async startTerminal(): Promise<TerminalSession> {
    if (this.terminal) {
      return this.terminal;
    }
    if (this.closed) {
      throw new Error("Claude (Terminal) session is closed");
    }
    // NOTE: Two Claude Code processes must not resume one session at the same time.
    this.spawning ??= this.stopping
      .then(() => this.spawnTerminal())
      .finally(() => {
        this.spawning = null;
      });
    return this.spawning;
  }

  // NOTE: Claude Code's /model and /effort save the choice to the user's settings.json, so
  // the session restarts with per-session flags instead, once no turn runs.
  private async relaunch(): Promise<void> {
    if (this.activeTurnId) {
      this.relaunchPending = true;
      return;
    }
    this.relaunchPending = false;
    const terminal = this.spawning ? await this.spawning.catch(() => null) : this.terminal;
    if (!terminal || this.terminal !== terminal || this.closed) {
      return;
    }
    this.detachTerminal();
    this.stopPolling();
    this.stopping = this.options.terminalManager
      .killTerminalAndWait(terminal.id)
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, "Failed to stop Claude Code for a restart");
      });
    await this.startTerminal();
  }

  private async spawnTerminal(): Promise<TerminalSession> {
    const workspaceId = this.options.launchContext?.workspaceId;
    if (!workspaceId) {
      throw new Error("Claude (Terminal) agents need a workspace for their terminal.");
    }
    const launch = await resolveProviderLaunch({
      commandConfig: this.options.runtimeSettings?.command,
      defaultBinary: "claude",
    });
    const availability = await checkProviderLaunchAvailable(launch);
    if (!availability.available) {
      throw new Error("Claude Code is not installed. Install it and make sure it is on PATH.");
    }
    const hooks = await this.registerHooks();
    const mcpConfigPath = await this.writeMcpConfig();
    const resuming = existsSync(this.options.resolveTranscriptPath(this.sessionId));
    const terminal = await this.options.terminalManager.createTerminal({
      cwd: this.options.config.cwd,
      workspaceId,
      ...(this.options.launchContext?.agentId
        ? { agentId: this.options.launchContext.agentId }
        : {}),
      name: "Claude",
      command: availability.resolvedPath ?? launch.command,
      args: [
        ...launch.args,
        resuming ? "--resume" : "--session-id",
        this.sessionId,
        ...configArgs(
          this.options.config,
          hooks ? claudeHookSettings(hooks.url, CLAUDE_HOOK_EVENTS) : {},
        ),
        ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
      ],
      env: {
        ...this.options.runtimeSettings?.env,
        ...this.options.launchContext?.env,
        ...(hooks ? { [CLAUDE_HOOK_TOKEN_ENV]: hooks.token } : {}),
      },
    });
    this.attachTerminal(terminal);
    return terminal;
  }

  // NOTE: Without hooks Claude Code still runs, so a hook server that fails to start loses
  // only what the hooks report.
  private registerHooks(): Promise<ClaudeHookRegistration | null> {
    this.hooks ??= this.options.hookServer
      .register((input) => this.handleHook(input))
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, "Failed to start the Claude Code hook server");
        return null;
      });
    return this.hooks;
  }

  private async handleHook(input: ClaudeHookInput): Promise<ClaudeHookOutput> {
    if (input.session_id !== this.sessionId && input.hook_event_name !== "SessionEnd") {
      await this.followSession(input.session_id);
    }
    this.observeMode(input.permission_mode);
    if (input.hook_event_name === "PreToolUse" && typeof input.tool_use_id === "string") {
      this.toolUseIds.set(toolCallKey(input.tool_name, input.tool_input), input.tool_use_id);
    } else if (input.hook_event_name === "PermissionRequest") {
      return this.requestPermission(input);
    } else if (input.hook_event_name === "Notification" && typeof input.message === "string") {
      this.lastNotification = { message: input.message, at: Date.now() };
    }
    return {};
  }

  // NOTE: The user can switch modes in Claude Code, such as with Shift+Tab or by approving a
  // plan, and its hooks report the mode in use. A mode Paseo set waits for the restart that
  // applies it, so the hooks of the running turn still report the old one.
  private observeMode(permissionMode: unknown): void {
    if (
      typeof permissionMode !== "string" ||
      !isClaudeModeId(permissionMode) ||
      permissionMode === this.options.config.modeId ||
      this.relaunchPending
    ) {
      return;
    }
    this.options.config.modeId = permissionMode;
    this.emit({
      type: "mode_changed",
      provider: this.provider,
      currentModeId: permissionMode,
      availableModes: CLAUDE_MODES,
    });
  }

  private async requestPermission(input: ClaudeHookInput): Promise<ClaudeHookOutput> {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
    const key = toolCallKey(input.tool_name, input.tool_input);
    const toolUseId = this.toolUseIds.get(key);
    this.toolUseIds.delete(key);
    const request = buildClaudePermissionRequest({
      requestId: `permission-${randomUUID()}`,
      provider: this.provider,
      toolName,
      input: toolInput,
      toolUseId,
      suggestions: Array.isArray(input.permission_suggestions)
        ? input.permission_suggestions
            .filter(isRecord)
            .map((suggestion) => suggestion as AgentPermissionUpdate)
        : undefined,
    });
    // The transcript already holds the tool call the request is about.
    await this.refreshTimeline();
    this.clearTerminalWait();
    return new Promise((resolve) => {
      this.pendingPermissions.set(request.id, {
        request,
        shown: isAwaitingAnswer(this.terminal?.getActivity() ?? null),
        answer: resolve,
      });
      this.emit({ type: "permission_requested", provider: this.provider, request });
    });
  }

  private settlePermission(
    requestId: string,
    output: ClaudeHookOutput,
    resolution: AgentPermissionResponse,
  ): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    pending.answer(output);
    this.emit({ type: "permission_resolved", provider: this.provider, requestId, resolution });
  }

  private denyPermissions(response: Extract<AgentPermissionResponse, { behavior: "deny" }>): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      this.settlePermission(requestId, permissionHookOutput(pending.request, response), response);
    }
  }

  /** Leaves the hooks without a decision, so Claude Code keeps its own dialog. */
  private cancelPermissions(): void {
    for (const requestId of this.pendingPermissions.keys()) {
      this.settlePermission(
        requestId,
        {},
        { behavior: "deny", message: CANCELED_PERMISSION_MESSAGE },
      );
    }
  }

  // NOTE: Claude Code keeps waiting for the hook after the user answers its dialog, so
  // leaving the dialog settles the request. Working again means the user allowed the tool.
  private trackPermissionDialogs(activity: TerminalActivity | null): void {
    const awaitingAnswer = isAwaitingAnswer(activity);
    for (const [requestId, pending] of this.pendingPermissions) {
      if (awaitingAnswer) {
        pending.shown = true;
      } else if (pending.shown) {
        this.settlePermission(
          requestId,
          {},
          activity?.state === "working"
            ? { behavior: "allow" }
            : { behavior: "deny", message: TERMINAL_DENIED_MESSAGE },
        );
      }
    }
  }

  private async waitForDialogToClose(terminal: TerminalSession): Promise<void> {
    const deadline = Date.now() + PERMISSION_DIALOG_SETTLE_TIMEOUT_MS;
    while (isAwaitingAnswer(terminal.getActivity()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // NOTE: /clear starts a new session with its own transcript. The hooks of the next prompt
  // carry its ID.
  private async followSession(sessionId: string): Promise<void> {
    const previousSessionId = this.sessionId;
    this.sessionId = sessionId;
    await this.refreshTimeline();
    this.transcript = this.options.followNewTranscript(sessionId);
    this.usage = new ClaudeTranscriptUsage(this.options.resolveTranscriptPath(sessionId));
    this.logger.info({ previousSessionId, sessionId }, "Claude Code switched to a new session");
    this.emit({ type: "thread_started", provider: this.provider, sessionId });
  }

  // NOTE: Claude Code may first ask in its terminal, such as whether to trust the folder,
  // so readiness is checked on every prompt rather than once at start.
  private async readyTerminal(): Promise<TerminalSession> {
    const terminal = await this.startTerminal();
    await this.waitForReady(terminal);
    return terminal;
  }

  private attachTerminal(terminal: TerminalSession): void {
    this.terminal = terminal;
    this.terminalSubscriptions = [
      terminal.onActivityChange((transition) => {
        this.trackTerminalWait(transition.activity, transition.statusMessage);
        void this.handleActivity(transition.activity);
      }),
      terminal.onExit(() => {
        void this.handleTerminalExit(terminal);
      }),
    ];
    this.startPolling();
  }

  private detachTerminal(): void {
    this.clearTerminalWait();
    for (const unsubscribe of this.terminalSubscriptions) {
      unsubscribe();
    }
    this.terminalSubscriptions = [];
    this.terminal = null;
  }

  // NOTE: Claude Code reports program status once its UI accepts input. Pasting before
  // that loses the prompt.
  private async waitForReady(terminal: TerminalSession): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (terminal.getActivity() === null) {
      if (this.terminal !== terminal) {
        throw new Error("Claude Code exited before it was ready.");
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Claude Code is not ready. Answer any question in its terminal, such as whether to trust the folder, then send the prompt again. If it asks nothing, update Claude Code: Paseo needs a version that reports its status with OSC 7501.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async handleActivity(activity: TerminalActivity | null): Promise<void> {
    this.trackPermissionDialogs(activity);
    if (!this.activeTurnId) {
      if (isWorking(activity)) {
        this.startTerminalTurn();
      }
      return;
    }
    if (isWorking(activity)) {
      this.turnWorking = true;
      this.clearTurnStartTimer();
      return;
    }
    if (this.turnWorking) {
      await this.finishTurn();
    }
  }

  private async handleTerminalExit(terminal: TerminalSession): Promise<void> {
    if (this.terminal !== terminal) {
      return;
    }
    this.detachTerminal();
    this.stopPolling();
    this.cancelPermissions();
    if (this.activeTurnId) {
      await this.finishTurn();
    }
  }

  // A prompt typed in the terminal starts an autonomous turn, like a turn the provider
  // starts on its own, so the manager gives it an ID.
  private startTerminalTurn(): void {
    this.activeTurnId = randomUUID();
    this.usage.beginTurn();
    this.turnStartedInTerminal = true;
    this.turnWorking = true;
    this.interruptRequested = false;
    this.emit({ type: "turn_started", provider: this.provider });
  }

  private async finishTurn(): Promise<void> {
    const turnId = this.activeTurnId;
    if (!turnId) {
      return;
    }
    await this.settleTimeline();
    if (this.activeTurnId !== turnId) {
      return;
    }
    const eventTurnId = this.turnStartedInTerminal ? {} : { turnId };
    this.activeTurnId = null;
    this.turnStartedInTerminal = false;
    this.turnWorking = false;
    this.clearTurnStartTimer();
    this.cancelPermissions();
    this.toolUseIds.clear();
    if (this.relaunchPending) {
      void this.relaunch().catch((error: unknown) => {
        this.logger.warn({ err: error }, "Failed to restart Claude Code with new flags");
      });
    }
    if (this.interruptRequested) {
      this.interruptRequested = false;
      this.emit({
        type: "turn_canceled",
        provider: this.provider,
        reason: "Interrupted",
        ...eventTurnId,
      });
      return;
    }
    const usage = this.usage.turnUsage();
    this.emit({
      type: "turn_completed",
      provider: this.provider,
      ...eventTurnId,
      ...(usage ? { usage: { ...usage, ...this.contextWindowUsage() } } : {}),
    });
  }

  // NOTE: Claude Code writes the last reply to the transcript shortly after it reports
  // idle, so the turn ends once the transcript stays quiet.
  private async settleTimeline(): Promise<void> {
    const deadline = Date.now() + TRANSCRIPT_SETTLE_TIMEOUT_MS;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      if ((await this.refreshTimeline()) > 0) {
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= TRANSCRIPT_QUIET_MS) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Emits the timeline items the transcript gained and returns how many. */
  private async refreshTimeline(): Promise<number> {
    try {
      const turnId = this.turnStartedInTerminal ? undefined : (this.activeTurnId ?? undefined);
      const events = await this.transcript.readNewTimeline();
      for (const event of events) {
        if (event.type !== "timeline") {
          this.emit(event);
          continue;
        }
        const echoed = this.withEcho(event);
        this.emit(turnId ? { ...echoed, turnId } : echoed);
      }
      if (await this.usage.read()) {
        this.emit({
          type: "usage_updated",
          provider: this.provider,
          usage: this.contextWindowUsage(),
          ...(turnId ? { turnId } : {}),
        });
      }
      return events.length;
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read the Claude Code transcript");
      return 0;
    }
  }

  // NOTE: Keys go out one submission at a time. Input sent before a prompt's Enter would
  // join that prompt.
  private submitPrompt(
    terminal: TerminalSession,
    text: string,
    imagePaths: string[],
    echo: Omit<PendingEcho, "text">,
  ): Promise<void> {
    this.pendingEchoes.push({ text: normalizeEchoText(text), ...echo });
    const submitted = this.typing.then(() => typePrompt(terminal, text, imagePaths));
    this.typing = submitted.catch(() => undefined);
    return submitted;
  }

  private async ensureFileDir(): Promise<string> {
    this.fileDir ??= await mkdtemp(join(tmpdir(), "paseo-claude-terminal-"));
    return this.fileDir;
  }

  // NOTE: The config goes in a file rather than the arguments, since headers such as the
  // Paseo MCP server's bearer token would otherwise show in the process list.
  private async writeMcpConfig(): Promise<string | null> {
    const servers = this.options.config.mcpServers;
    if (!servers || Object.keys(servers).length === 0) {
      return null;
    }
    const mcpServers = Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [name, toClaudeSdkMcpConfig(server)]),
    );
    const configPath = join(await this.ensureFileDir(), "mcp-config.json");
    await writeFile(configPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
    return configPath;
  }

  private async writeImages(images: TerminalPrompt["images"]): Promise<string[]> {
    if (images.length === 0) {
      return [];
    }
    const imageDir = await this.ensureFileDir();
    return Promise.all(
      images.map(async (image) => {
        const extension = IMAGE_EXTENSIONS[image.mimeType];
        if (!extension) {
          throw new Error(`Claude (Terminal) agents cannot attach ${image.mimeType} images.`);
        }
        const imagePath = join(imageDir, `${randomUUID()}.${extension}`);
        await writeFile(imagePath, Buffer.from(image.data, "base64"), { mode: 0o600 });
        return imagePath;
      }),
    );
  }

  private withEcho(
    event: Extract<AgentStreamEvent, { type: "timeline" }>,
  ): Extract<AgentStreamEvent, { type: "timeline" }> {
    if (event.item.type !== "user_message") {
      return event;
    }
    const messageId = event.item.messageId;
    let clientMessageId = messageId ? this.echoedMessages.get(messageId) : undefined;
    if (!clientMessageId) {
      const text = normalizeEchoText(event.item.text);
      const index = this.pendingEchoes.findIndex((pending) => pending.text === text);
      if (index === -1) {
        return event;
      }
      clientMessageId = this.pendingEchoes.splice(index, 1)[0]?.clientMessageId;
      if (messageId && clientMessageId) {
        this.echoedMessages.set(messageId, clientMessageId);
      }
    }
    return clientMessageId ? { ...event, item: { ...event.item, clientMessageId } } : event;
  }

  private contextWindowUsage(): AgentUsage {
    const context = this.usage.contextUsage();
    if (!context) {
      return {};
    }
    // The configured model can carry a context window suffix, such as [1m], that the
    // transcript's model ID drops.
    const maxTokens =
      getClaudeContextWindowMaxTokens(this.options.config.model) ??
      getClaudeContextWindowMaxTokens(context.model);
    return {
      contextWindowUsedTokens: context.usedTokens,
      ...(maxTokens ? { contextWindowMaxTokens: maxTokens } : {}),
    };
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.refreshTimeline();
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // NOTE: Claude Code reports blocked for each dialog it registers as waiting for the user,
  // such as a paused session or an MCP server asking for input, with what it needs as the
  // message. A blocked state no Paseo permission request explains is one only its terminal
  // can answer, and a paste would land in that dialog, with Enter choosing an option.
  private trackTerminalWait(activity: TerminalActivity | null, statusMessage?: string): void {
    if (!isAwaitingAnswer(activity)) {
      this.clearTerminalWait();
      return;
    }
    if (this.terminalWait || this.terminalWaitTimer) {
      return;
    }
    this.terminalWaitTimer = setTimeout(() => {
      this.terminalWaitTimer = null;
      if (!isAwaitingAnswer(this.terminal?.getActivity() ?? null) || this.pendingPermissions.size) {
        return;
      }
      const notification = this.lastNotification;
      const message =
        statusMessage ??
        (notification && Date.now() - notification.at < NOTIFICATION_RECENT_MS
          ? notification.message
          : null);
      this.terminalWait = { message };
      this.emit({
        type: "timeline",
        provider: this.provider,
        item: {
          type: "notification",
          level: "warning",
          message: message
            ? `Claude Code is waiting for you in its terminal: ${message}`
            : "Claude Code is waiting for you in its terminal.",
        },
      });
    }, TERMINAL_WAIT_GRACE_MS);
  }

  private clearTerminalWait(): void {
    if (this.terminalWaitTimer) {
      clearTimeout(this.terminalWaitTimer);
      this.terminalWaitTimer = null;
    }
    this.terminalWait = null;
  }

  private assertNotWaitingInTerminal(): void {
    if (!this.terminalWait) {
      return;
    }
    const { message } = this.terminalWait;
    throw new Error(
      `Claude Code is waiting for you in its terminal${message ? `: ${message}` : ""}. Answer it there, then send again.`,
    );
  }

  private clearTurnStartTimer(): void {
    if (this.turnStartTimer) {
      clearTimeout(this.turnStartTimer);
      this.turnStartTimer = null;
    }
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of Array.from(this.subscribers)) {
      try {
        subscriber(event);
      } catch (error) {
        this.logger.warn({ err: error }, "Claude (Terminal) session subscriber failed");
      }
    }
  }
}

/**
 * Runs Claude sessions as the interactive Claude Code CLI in Paseo terminals instead
 * of through the Agent SDK.
 */
export class ClaudeTerminalAgentClient implements AgentClient {
  readonly provider = CLAUDE_TERMINAL_PROVIDER;
  readonly capabilities = CLAUDE_TERMINAL_CAPABILITIES;
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly terminalManager?: TerminalManager;
  private readonly options: ClaudeTerminalAgentClientOptions;
  private claudeClient: ClaudeAgentClient | null;
  private readonly hookServer: ClaudeHookServer;

  constructor(options: ClaudeTerminalAgentClientOptions) {
    this.options = options;
    this.logger = options.logger.child({ module: "agent", provider: CLAUDE_TERMINAL_PROVIDER });
    this.runtimeSettings = options.runtimeSettings;
    this.terminalManager = options.terminalManager;
    this.claudeClient = options.claude ?? null;
    this.hookServer = new ClaudeHookServer(this.logger);
  }

  private get claude(): ClaudeAgentClient {
    this.claudeClient ??= new ClaudeAgentClient({
      logger: this.options.logger,
      runtimeSettings: this.options.runtimeSettings,
      // NOTE: Discovery asks Claude Code for its models over the Agent SDK. Without it
      // the catalog is the curated models plus the ones the config dir's settings.json
      // names, so a model that needs verified access appears once settings names it.
      discoverModels: async () => [],
    });
    return this.claudeClient;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = await this.openSession(randomUUID(), config, launchContext);
    await session.startTerminal();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const merged = { ...metadata, ...overrides };
    if (!merged.cwd) {
      throw new Error("Claude (Terminal) resume requires the original working directory");
    }
    // The terminal starts on the next prompt, so opening an agent never starts Claude Code.
    return this.openSession(
      handle.sessionId,
      { ...merged, provider: CLAUDE_TERMINAL_PROVIDER, cwd: merged.cwd },
      launchContext,
    );
  }

  // Without this, listing a draft's features creates a session, which starts Claude Code.
  async listFeatures(): Promise<AgentFeature[]> {
    return [];
  }

  // A draft has no transcript yet, so its commands come from the files alone.
  async listCommands(config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    return listClaudeTerminalCommands({
      configDir: claudeConfigDir({ ...process.env, ...this.runtimeSettings?.env }),
      cwd: config.cwd,
    });
  }

  async getCatalogCacheKey(options: FetchCatalogOptions): Promise<string | undefined> {
    return this.claude.getCatalogCacheKey(options);
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    return this.claude.fetchCatalog(options, context);
  }

  resolveConfiguredModel(model: AgentModelDefinition): AgentModelDefinition {
    return this.claude.resolveConfiguredModel(model);
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.terminalManager) && (await this.claude.isAvailable());
  }

  private async openSession(
    sessionId: string,
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<ClaudeTerminalAgentSession> {
    if (!this.terminalManager) {
      throw new Error("Claude (Terminal) agents need the daemon's terminals.");
    }
    const env = { ...this.runtimeSettings?.env, ...launchContext?.env };
    const claudeConfig = { ...config, provider: "claude" };
    const resolveTranscriptPath = (transcriptSessionId: string) =>
      claudeTranscriptPathSync({
        cwd: config.cwd,
        sessionId: transcriptSessionId,
        configDir: claudeConfigDir({ ...process.env, ...env }),
      });
    const transcriptOptions = (transcriptSessionId: string) => {
      const handle: AgentPersistenceHandle = {
        provider: "claude",
        sessionId: transcriptSessionId,
        metadata: claudeConfig,
      };
      return {
        logger: this.logger,
        provider: CLAUDE_TERMINAL_PROVIDER,
        resolveTranscriptPath: () => resolveTranscriptPath(transcriptSessionId),
        loadHistory: () => this.claude.loadSessionHistory(handle, claudeConfig, launchContext),
      };
    };
    return new ClaudeTerminalAgentSession({
      logger: this.logger,
      terminalManager: this.terminalManager,
      runtimeSettings: this.runtimeSettings,
      sessionId,
      config,
      launchContext,
      transcript: await ClaudeTranscriptFollower.create(transcriptOptions(sessionId)),
      resolveTranscriptPath,
      followNewTranscript: (newSessionId) =>
        ClaudeTranscriptFollower.createAtStart(transcriptOptions(newSessionId)),
      hookServer: this.hookServer,
    });
  }
}
