import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClaudeTranscriptUsage } from "./transcript-usage.js";

function assistantRecord(input: {
  id: string;
  usage: Record<string, number>;
  isSidechain?: boolean;
}): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: input.isSidechain ?? false,
    message: { id: input.id, model: "claude-opus-5-5", content: [], usage: input.usage },
  })}\n`;
}

describe("ClaudeTranscriptUsage", () => {
  let tempRoot: string;
  let transcriptPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-transcript-usage-"));
    transcriptPath = path.join(tempRoot, "session.jsonl");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("counts each response once and follows the latest one for the context", async () => {
    const usage = new ClaudeTranscriptUsage(transcriptPath);
    await expect(usage.read()).resolves.toBe(false);

    const first = {
      input_tokens: 2,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 100,
      output_tokens: 7,
    };
    writeFileSync(
      transcriptPath,
      assistantRecord({ id: "msg_1", usage: first }) +
        assistantRecord({ id: "msg_1", usage: first }) +
        assistantRecord({ id: "msg_side", usage: { input_tokens: 500 }, isSidechain: true }),
    );
    usage.beginTurn();
    await expect(usage.read()).resolves.toBe(true);
    expect(usage.contextUsage()).toEqual({ usedTokens: 139, model: "claude-opus-5-5" });

    const second = { input_tokens: 3, cache_read_input_tokens: 130, output_tokens: 4 };
    const line = assistantRecord({ id: "msg_2", usage: second });
    appendFileSync(transcriptPath, line.slice(0, 20));
    await expect(usage.read()).resolves.toBe(false);
    appendFileSync(transcriptPath, line.slice(20));
    await expect(usage.read()).resolves.toBe(true);

    expect(usage.contextUsage()).toEqual({ usedTokens: 137, model: "claude-opus-5-5" });
    expect(usage.turnUsage()).toEqual({ inputTokens: 5, cachedInputTokens: 230, outputTokens: 11 });
    usage.beginTurn();
    expect(usage.turnUsage()).toBeUndefined();
  });
});
