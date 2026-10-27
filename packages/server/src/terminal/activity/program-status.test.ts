import { describe, expect, it } from "vitest";
import { ProgramStatusRecords, parseProgramStatusReport } from "./program-status.js";

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function applyAll(records: ProgramStatusRecords, bodies: string[]): void {
  for (const body of bodies) {
    const report = parseProgramStatusReport(body);
    if (!report) {
      throw new Error(`Expected a report for ${body}`);
    }
    records.apply(report);
  }
}

describe("parseProgramStatusReport", () => {
  it("parses a Claude Code blocked report", () => {
    const body = `state=blocked:app=claude-code:kind=permission:msg=${base64("approve Bash: ls")}`;

    expect(parseProgramStatusReport(body)).toEqual({
      type: "set",
      record: {
        id: "",
        state: "blocked",
        app: "claude-code",
        kind: "permission",
        msg: "approve Bash: ls",
      },
    });
  });

  it("keeps progress only for working and blocked states", () => {
    expect(parseProgramStatusReport("state=working:progress=40")).toMatchObject({
      record: { state: "working", progress: 40 },
    });
    expect(parseProgramStatusReport("state=done:progress=40")).toEqual({
      type: "set",
      record: { id: "", state: "done" },
    });
    expect(parseProgramStatusReport("state=working:progress=101")).toEqual({
      type: "set",
      record: { id: "", state: "working" },
    });
  });

  it("uses the last value of a repeated key and skips malformed pairs", () => {
    expect(parseProgramStatusReport("state=idle:garbage:state=working:=x")).toEqual({
      type: "set",
      record: { id: "", state: "working" },
    });
  });

  it("parses clear with and without an id", () => {
    expect(parseProgramStatusReport("state=clear")).toEqual({ type: "clear", id: null });
    expect(parseProgramStatusReport("state=clear:id=deploy/us")).toEqual({
      type: "clear",
      id: "deploy/us",
    });
  });

  it.each([
    ["the feature detection query", "?"],
    ["a missing state", "app=claude-code"],
    ["an unknown state", "state=sleeping"],
    ["a malformed id", "state=working:id=a//b"],
    ["an id deeper than eight levels", "state=working:id=a/b/c/d/e/f/g/h/i"],
    ["invalid base64", "state=working:msg=!!!"],
    ["a control character in msg", `state=working:msg=${base64("line\nbreak")}`],
    ["a C1 control character in title", `state=working:title=${base64("a\u0085b")}`],
    ["invalid UTF-8", `state=working:msg=${Buffer.from([0xff]).toString("base64")}`],
    ["an oversized title", `state=working:title=${base64("x".repeat(193))}`],
    ["an oversized app", `state=working:app=${"x".repeat(33)}`],
    ["an oversized key", `state=working:${"k".repeat(17)}=v`],
    ["an oversized sequence", `state=working:pad=${"x".repeat(4096)}`],
  ])("ignores %s", (_name, body) => {
    expect(parseProgramStatusReport(body)).toBeNull();
  });
});

describe("ProgramStatusRecords", () => {
  it("replaces a record completely on each report", () => {
    const records = new ProgramStatusRecords();

    applyAll(records, ["state=working:progress=10:app=cargo", "state=working"]);

    expect(records.list()).toEqual([{ id: "", state: "working" }]);
  });

  it("clears a record together with its descendants", () => {
    const records = new ProgramStatusRecords();

    applyAll(records, [
      "state=working:id=deploy",
      "state=working:id=deploy/us",
      "state=blocked:id=deploy/eu",
      "state=working:id=deployment",
      "state=clear:id=deploy",
    ]);

    expect(records.list().map((record) => record.id)).toEqual(["deployment"]);
  });

  it("drops working and blocked records at a new prompt", () => {
    const records = new ProgramStatusRecords();

    applyAll(records, [
      "state=working:id=a",
      "state=blocked:id=b",
      "state=done:id=c",
      "state=error:id=d",
      "state=idle:id=e",
    ]);
    records.dropTransient();

    expect(records.list().map((record) => record.id)).toEqual(["c", "d", "e"]);
  });

  it("evicts the least recently updated record past 256 records", () => {
    const records = new ProgramStatusRecords();

    for (let index = 0; index < 256; index += 1) {
      applyAll(records, [`state=working:id=task${index}`]);
    }
    applyAll(records, ["state=done:id=task0", "state=working:id=task256"]);

    const ids = records.list().map((record) => record.id);
    expect(ids).toHaveLength(256);
    expect(ids).not.toContain("task1");
    expect(ids).toContain("task0");
  });

  it("describes the activity with the msg of the latest deciding record", () => {
    const records = new ProgramStatusRecords();

    applyAll(records, [
      `state=blocked:id=a:msg=${base64("approve Bash: ls")}`,
      `state=working:id=b:msg=${base64("reading files")}`,
      `state=blocked:id=c:msg=${base64("approve Edit: README.md")}`,
    ]);

    expect(records.describeActivity("needs_input")).toBe("approve Edit: README.md");
    expect(records.describeActivity("working")).toBe("reading files");
    expect(records.describeActivity("finished")).toBeUndefined();
  });

  it.each([
    [[], null],
    [["state=idle"], "idle"],
    [["state=idle", "state=done:id=a"], "finished"],
    [["state=error:id=a"], "finished"],
    [["state=done", "state=working:id=a"], "working"],
    [["state=working", "state=blocked:id=a"], "needs_input"],
  ])("derives activity from %j", (bodies, activity) => {
    const records = new ProgramStatusRecords();

    applyAll(records, bodies);

    expect(records.deriveActivity()).toBe(activity);
  });
});
