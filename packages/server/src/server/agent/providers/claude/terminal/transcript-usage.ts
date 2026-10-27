import { open } from "node:fs/promises";
import type { AgentUsage } from "../../../agent-sdk-types.js";

interface MessageUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

const NEWLINE = 0x0a;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCount(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function totalTokens(usage: MessageUsage): number {
  return (
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens +
    usage.outputTokens
  );
}

/**
 * Reads token usage from a Claude Code transcript as it grows.
 *
 * NOTE: Claude Code journals each content block of an API response as its own record, and
 * every one carries the whole response's usage, so usage counts once per message ID.
 */
export class ClaudeTranscriptUsage {
  private readonly transcriptPath: string;
  private offset = 0;
  private partialLine: Buffer = Buffer.alloc(0);
  private latest: { usage: MessageUsage; model: string | null } | null = null;
  private readonly turnMessages = new Map<string, MessageUsage>();

  constructor(transcriptPath: string) {
    this.transcriptPath = transcriptPath;
  }

  /** Reads the records appended since the last call and returns whether usage changed. */
  async read(): Promise<boolean> {
    let handle;
    try {
      handle = await open(this.transcriptPath, "r");
    } catch {
      return false;
    }
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        this.offset = 0;
        this.partialLine = Buffer.alloc(0);
      }
      if (size === this.offset) {
        return false;
      }
      const appended = Buffer.alloc(size - this.offset);
      const { bytesRead } = await handle.read(appended, 0, appended.length, this.offset);
      this.offset += bytesRead;
      const text = Buffer.concat([this.partialLine, appended.subarray(0, bytesRead)]);
      const end = text.lastIndexOf(NEWLINE);
      this.partialLine = Buffer.from(text.subarray(end + 1));
      let changed = false;
      for (const line of text
        .subarray(0, end + 1)
        .toString("utf8")
        .split("\n")) {
        changed = this.readRecord(line) || changed;
      }
      return changed;
    } finally {
      await handle.close();
    }
  }

  /** Starts counting the usage of a new turn. */
  beginTurn(): void {
    this.turnMessages.clear();
  }

  /** The tokens the latest response put in the context window, with the model that ran it. */
  contextUsage(): { usedTokens: number; model: string | null } | null {
    return this.latest
      ? { usedTokens: totalTokens(this.latest.usage), model: this.latest.model }
      : null;
  }

  /** The tokens of the responses since the turn began. */
  turnUsage(): AgentUsage | undefined {
    if (this.turnMessages.size === 0) {
      return undefined;
    }
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    for (const message of this.turnMessages.values()) {
      usage.inputTokens += message.inputTokens;
      usage.cachedInputTokens += message.cacheReadInputTokens;
      usage.outputTokens += message.outputTokens;
    }
    return usage;
  }

  private readRecord(line: string): boolean {
    if (!line.trim()) {
      return false;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return false;
    }
    if (!isRecord(record) || record.type !== "assistant" || record.isSidechain === true) {
      return false;
    }
    const message = record.message;
    if (!isRecord(message) || typeof message.id !== "string" || !isRecord(message.usage)) {
      return false;
    }
    const usage: MessageUsage = {
      inputTokens: readCount(message.usage, "input_tokens"),
      cacheCreationInputTokens: readCount(message.usage, "cache_creation_input_tokens"),
      cacheReadInputTokens: readCount(message.usage, "cache_read_input_tokens"),
      outputTokens: readCount(message.usage, "output_tokens"),
    };
    // Claude Code's own synthetic messages, such as an interrupt notice, report no usage.
    if (totalTokens(usage) === 0) {
      return false;
    }
    this.latest = { usage, model: typeof message.model === "string" ? message.model : null };
    this.turnMessages.set(message.id, usage);
    return true;
  }
}
