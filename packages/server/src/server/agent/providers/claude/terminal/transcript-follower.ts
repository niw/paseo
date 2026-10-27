import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import type {
  AgentProvider,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../../agent-sdk-types.js";

export interface ClaudeTranscriptFollowerOptions {
  logger: Logger;
  /** The provider the emitted events belong to. */
  provider: AgentProvider;
  /** The transcript file, re-resolved because Claude Code creates it on the first prompt. */
  resolveTranscriptPath: () => Promise<string>;
  /** Converts the whole transcript into history events. */
  loadHistory: () => Promise<AgentStreamEvent[]>;
}

type SubagentEvent = Extract<AgentStreamEvent, { type: "provider_subagent" }>;

// Identity only: a tool call's later status arrives as another item, not as a change to this one.
function timelineKey(item: AgentTimelineItem): string {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return `${item.type}:${item.messageId ?? item.text}`;
    case "tool_call":
      return `tool_call:${item.callId}`;
    default:
      return item.type;
  }
}

function timelineKeys(history: AgentStreamEvent[]): string[] {
  return history.flatMap((event) => (event.type === "timeline" ? [timelineKey(event.item)] : []));
}

function withProvider(events: AgentStreamEvent[], provider: AgentProvider): AgentStreamEvent[] {
  return events.map((event) => ({ ...event, provider }) as AgentStreamEvent);
}

/**
 * Follows a Claude Code transcript that another process writes.
 *
 * NOTE: The transcript conversion is append-only as the transcript grows, so each
 * change yields only the timeline items past the ones already yielded. A subagent's
 * timeline grows the same way, and its descriptor is yielded again when it changes.
 * A rewind in Claude Code changes items already yielded instead, so the follower then
 * yields history_reset and offers the whole history again.
 */
export class ClaudeTranscriptFollower {
  private readonly options: ClaudeTranscriptFollowerOptions;
  private pendingHistory: AgentStreamEvent[] | null;
  /** The pending history comes from a reset, so events yielded until it is taken join it. */
  private pendingHistoryFromReset = false;
  /** Identifies each timeline item yielded, to notice a history that changed in place. */
  private emittedTimelineKeys: string[] = [];
  /** How many timeline items each subagent yielded. */
  private readonly emittedSubagentTimelineCounts = new Map<string, number>();
  /** The descriptor changes each subagent yielded, since one conversion can hold several. */
  private readonly emittedSubagentStates = new Map<string, Set<string>>();
  private transcriptSignature: string | null = null;
  private reading: Promise<unknown> = Promise.resolve();

  private constructor(options: ClaudeTranscriptFollowerOptions, history: AgentStreamEvent[]) {
    this.options = options;
    this.pendingHistory = history;
    this.selectNewEvents(history);
  }

  static async create(options: ClaudeTranscriptFollowerOptions): Promise<ClaudeTranscriptFollower> {
    const history = withProvider(await options.loadHistory(), options.provider);
    const follower = new ClaudeTranscriptFollower(options, history);
    follower.transcriptSignature = await follower.readTranscriptSignature();
    return follower;
  }

  /** Follows a transcript from its start, such as the one a new session writes. */
  static createAtStart(options: ClaudeTranscriptFollowerOptions): ClaudeTranscriptFollower {
    return new ClaudeTranscriptFollower(options, []);
  }

  /** The history the transcript held when following started or last reset. Returns it once. */
  takeHistory(): AgentStreamEvent[] {
    const history = this.pendingHistory ?? [];
    this.pendingHistory = null;
    this.pendingHistoryFromReset = false;
    return history;
  }

  /** Timeline and subagent events the transcripts gained since the last call. Calls run one at a time. */
  readNewTimeline(): Promise<AgentStreamEvent[]> {
    const next = this.reading.then(() => this.readNewTimelineNow());
    this.reading = next.catch(() => undefined);
    return next;
  }

  private async readNewTimelineNow(): Promise<AgentStreamEvent[]> {
    const signature = await this.readTranscriptSignature();
    if (signature === this.transcriptSignature) {
      return [];
    }
    this.transcriptSignature = signature;
    const history = withProvider(await this.options.loadHistory(), this.options.provider);
    const keys = timelineKeys(history);
    if (this.emittedTimelineKeys.some((key, index) => keys[index] !== key)) {
      this.options.logger.debug(
        { emitted: this.emittedTimelineKeys.length, current: keys.length },
        "Followed Claude Code transcript changed in place",
      );
      this.emittedTimelineKeys = [];
      this.emittedSubagentTimelineCounts.clear();
      this.emittedSubagentStates.clear();
      this.selectNewEvents(history);
      this.pendingHistory = history;
      this.pendingHistoryFromReset = true;
      return [{ type: "history_reset", provider: this.options.provider }];
    }
    const added = this.selectNewEvents(history);
    // NOTE: The timeline is rebuilt from the history once it is taken, which drops what was
    // yielded before that, so the history keeps it.
    if (this.pendingHistory && this.pendingHistoryFromReset) {
      this.pendingHistory.push(...added);
    }
    return added;
  }

  /** Records the events as yielded and returns the ones not yielded before. */
  private selectNewEvents(history: AgentStreamEvent[]): AgentStreamEvent[] {
    const added: AgentStreamEvent[] = [];
    let timelineIndex = 0;
    const subagentTimelineIndexes = new Map<string, number>();
    for (const event of history) {
      if (event.type === "timeline") {
        if (timelineIndex >= this.emittedTimelineKeys.length) {
          added.push(event);
        }
        timelineIndex += 1;
      } else if (event.type === "provider_subagent") {
        if (this.isNewSubagentEvent(event, subagentTimelineIndexes)) {
          added.push(event);
        }
      }
    }
    const keys = timelineKeys(history);
    if (keys.length > this.emittedTimelineKeys.length) {
      this.emittedTimelineKeys = keys;
    }
    for (const [id, count] of subagentTimelineIndexes) {
      this.emittedSubagentTimelineCounts.set(
        id,
        Math.max(this.emittedSubagentTimelineCounts.get(id) ?? 0, count),
      );
    }
    return added;
  }

  private isNewSubagentEvent(event: SubagentEvent, timelineIndexes: Map<string, number>): boolean {
    const subagentEvent = event.event;
    if (subagentEvent.type === "timeline") {
      const index = timelineIndexes.get(subagentEvent.id) ?? 0;
      timelineIndexes.set(subagentEvent.id, index + 1);
      return index >= (this.emittedSubagentTimelineCounts.get(subagentEvent.id) ?? 0);
    }
    const { timestamp: _timestamp, ...state } = subagentEvent as typeof subagentEvent & {
      timestamp?: string;
    };
    const key = JSON.stringify(state);
    const emitted = this.emittedSubagentStates.get(subagentEvent.id) ?? new Set<string>();
    if (emitted.has(key)) {
      return false;
    }
    emitted.add(key);
    this.emittedSubagentStates.set(subagentEvent.id, emitted);
    return true;
  }

  // Subagents write their own transcripts under the session's directory, so they can grow
  // while the session's transcript stays the same.
  private async readTranscriptSignature(): Promise<string | null> {
    const transcriptPath = await this.options.resolveTranscriptPath();
    let transcript;
    try {
      transcript = await stat(transcriptPath);
    } catch {
      return null;
    }
    const parts = [`${transcript.size}:${transcript.mtimeMs}`];
    const subagentDirectory = join(
      dirname(transcriptPath),
      basename(transcriptPath, ".jsonl"),
      "subagents",
    );
    let files: string[];
    try {
      files = (await readdir(subagentDirectory, { recursive: true })).sort();
    } catch {
      return parts[0] ?? null;
    }
    for (const file of files) {
      try {
        const stats = await stat(join(subagentDirectory, file));
        parts.push(`${file}:${stats.size}:${stats.mtimeMs}`);
      } catch {
        // A file removed while listing has nothing to follow.
      }
    }
    return parts.join("|");
  }
}
