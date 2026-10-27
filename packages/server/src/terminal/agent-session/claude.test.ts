import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessTableEntry } from "../../utils/process-tree.js";
import { findClaudeSessionInProcessTree } from "./claude.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createConfigDir(sessions: Record<number, unknown>): string {
  const configDir = mkdtempSync(join(tmpdir(), "claude-running-session-"));
  temporaryDirs.push(configDir);
  mkdirSync(join(configDir, "sessions"));
  for (const [pid, contents] of Object.entries(sessions)) {
    writeFileSync(
      join(configDir, "sessions", `${pid}.json`),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  return configDir;
}

// pty shell 100 runs claude 200, which runs a tool shell 300 with a nested claude 400.
// 500 is an unrelated claude.
const processTable: ProcessTableEntry[] = [
  { pid: 100, parentPid: 1 },
  { pid: 200, parentPid: 100 },
  { pid: 300, parentPid: 200 },
  { pid: 400, parentPid: 300 },
  { pid: 500, parentPid: 1 },
];

function listProcesses(): Promise<ProcessTableEntry[]> {
  return Promise.resolve(processTable);
}

describe.skipIf(process.platform === "win32")("findClaudeSessionInProcessTree", () => {
  it("finds the outermost Claude Code session under the root process", async () => {
    const configDir = createConfigDir({
      200: { pid: 200, sessionId: "outer-session", kind: "interactive" },
      400: { pid: 400, sessionId: "nested-session", kind: "interactive" },
      500: { pid: 500, sessionId: "unrelated-session", kind: "interactive" },
    });

    await expect(
      findClaudeSessionInProcessTree({
        rootPid: 100,
        env: { CLAUDE_CONFIG_DIR: configDir },
        listProcesses,
      }),
    ).resolves.toBe("outer-session");
  });

  it("finds Claude Code running as the root process", async () => {
    const configDir = createConfigDir({
      200: { pid: 200, sessionId: "direct-session" },
      400: { pid: 400, sessionId: "nested-session" },
    });

    await expect(
      findClaudeSessionInProcessTree({
        rootPid: 200,
        env: { CLAUDE_CONFIG_DIR: configDir },
        listProcesses,
      }),
    ).resolves.toBe("direct-session");
  });

  it("skips session files that are malformed or belong to another pid", async () => {
    const configDir = createConfigDir({
      200: "{not json",
      300: { pid: 999, sessionId: "recycled-pid-session" },
      400: { pid: 400, sessionId: "nested-session" },
    });

    await expect(
      findClaudeSessionInProcessTree({
        rootPid: 100,
        env: { CLAUDE_CONFIG_DIR: configDir },
        listProcesses,
      }),
    ).resolves.toBe("nested-session");
  });

  it("returns null when no Claude Code runs under the root process", async () => {
    const configDir = createConfigDir({
      500: { pid: 500, sessionId: "unrelated-session" },
    });

    await expect(
      findClaudeSessionInProcessTree({
        rootPid: 100,
        env: { CLAUDE_CONFIG_DIR: configDir },
        listProcesses,
      }),
    ).resolves.toBeNull();
  });

  it("returns null when the process list fails", async () => {
    await expect(
      findClaudeSessionInProcessTree({
        rootPid: 100,
        env: {},
        listProcesses: () => Promise.reject(new Error("ps failed")),
      }),
    ).resolves.toBeNull();
  });
});
