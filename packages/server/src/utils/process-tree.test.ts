import { describe, expect, it } from "vitest";
import { collectProcessTreePids, listProcesses, parseProcessTable } from "./process-tree.js";

describe("parseProcessTable", () => {
  it("parses ps pid and ppid columns", () => {
    expect(parseProcessTable("  100     1\n  200   100\ngarbage\n")).toEqual([
      { pid: 100, parentPid: 1 },
      { pid: 200, parentPid: 100 },
    ]);
  });
});

describe("collectProcessTreePids", () => {
  it("returns the root followed by its descendants breadth first", () => {
    const entries = [
      { pid: 100, parentPid: 1 },
      { pid: 200, parentPid: 100 },
      { pid: 300, parentPid: 200 },
      { pid: 250, parentPid: 100 },
      { pid: 500, parentPid: 1 },
    ];

    expect(collectProcessTreePids(entries, 100)).toEqual([100, 200, 250, 300]);
  });
});

describe.skipIf(process.platform === "win32")("listProcesses", () => {
  it("lists the current process under its parent", async () => {
    const entries = await listProcesses();

    expect(entries).toContainEqual({ pid: process.pid, parentPid: process.ppid });
  });
});
