import { describe, expect, test } from "vitest";
import { selectClaudeCurrentBranch, type ClaudeTranscriptNode } from "./transcript-branch.js";

function prompt(uuid: string, parentUuid: string | null): ClaudeTranscriptNode {
  return { type: "user", uuid, parentUuid, message: { content: uuid } };
}

function reply(uuid: string, parentUuid: string): ClaudeTranscriptNode {
  return { type: "assistant", uuid, parentUuid, message: { content: [] } };
}

function toolResult(uuid: string, parentUuid: string): ClaudeTranscriptNode {
  return { type: "user", uuid, parentUuid, message: { content: [{ type: "tool_result" }] } };
}

function kept(nodes: ClaudeTranscriptNode[]): unknown[] {
  const keep = selectClaudeCurrentBranch(nodes);
  return nodes.filter((_, index) => keep[index]).map((node) => node.uuid);
}

describe("selectClaudeCurrentBranch", () => {
  test("keeps a transcript without a rewind whole", () => {
    expect(
      kept([
        prompt("p1", null),
        reply("a1", "p1"),
        { type: "file-history-snapshot" },
        prompt("p2", "a1"),
        reply("a2", "p2"),
      ]),
    ).toEqual(["p1", "a1", undefined, "p2", "a2"]);
  });

  test("drops the turns a rewind abandoned", () => {
    expect(
      kept([
        prompt("p1", null),
        reply("a1", "p1"),
        prompt("p2", "a1"),
        reply("a2", "p2"),
        { type: "attachment", uuid: "x2", parentUuid: "a2" },
        prompt("p3", "a1"),
        reply("a3", "p3"),
      ]),
    ).toEqual(["p1", "a1", "p3", "a3"]);
  });

  test("keeps branches that hold no prompt, such as parallel tool results", () => {
    expect(
      kept([
        prompt("p1", null),
        reply("call1", "p1"),
        reply("call2", "call1"),
        toolResult("result1", "call1"),
        toolResult("result2", "call2"),
        { type: "progress", uuid: "progress", parentUuid: "call2" },
        reply("a1", "result2"),
      ]),
    ).toEqual(["p1", "call1", "call2", "result1", "result2", "progress", "a1"]);
  });

  test("follows a compaction boundary to the conversation before it", () => {
    expect(
      kept([
        prompt("p1", null),
        reply("a1", "p1"),
        { type: "system", uuid: "boundary", parentUuid: null, logicalParentUuid: "a1" },
        prompt("p2", "boundary"),
        reply("a2", "p2"),
      ]),
    ).toEqual(["p1", "a1", "boundary", "p2", "a2"]);
  });
});
