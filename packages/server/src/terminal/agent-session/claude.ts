import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  collectProcessTreePids,
  listProcesses as listProcessesWithPs,
  type ListProcesses,
  type ProcessTableEntry,
} from "../../utils/process-tree.js";
import { claudeConfigDir } from "../../server/agent/providers/claude/project-dir.js";

/** The `app` Claude Code reports in OSC 7501 program status. */
export const CLAUDE_CODE_PROGRAM_STATUS_APP = "claude-code";

export interface FindClaudeSessionInProcessTreeOptions {
  rootPid: number;
  env: Record<string, string | undefined>;
  listProcesses?: ListProcesses;
}

// NOTE: Claude Code writes `<config dir>/sessions/<pid>.json` for every running
// process and rewrites it when the live session changes, such as after /clear or
// /resume. The file is internal to Claude Code, so anything unexpected reads as
// no session.
async function readRunningSessionId(sessionsDir: string, pid: number): Promise<string | null> {
  let contents: string;
  try {
    contents = await readFile(join(sessionsDir, `${pid}.json`), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as { pid?: unknown; sessionId?: unknown };
  if (record.pid !== pid || typeof record.sessionId !== "string" || !record.sessionId) {
    return null;
  }
  return record.sessionId;
}

/**
 * The id of the Claude Code session running as `rootPid` or one of its descendants.
 * `rootPid` itself is Claude Code when a terminal starts it directly instead of a shell.
 * The outermost Claude Code process wins, so a Claude Code that a tool starts inside
 * another one does not replace the one the user is talking to.
 */
export async function findClaudeSessionInProcessTree(
  options: FindClaudeSessionInProcessTreeOptions,
): Promise<string | null> {
  if (process.platform === "win32") {
    return null;
  }
  const listProcesses = options.listProcesses ?? listProcessesWithPs;
  let entries: ProcessTableEntry[];
  try {
    entries = await listProcesses();
  } catch {
    return null;
  }
  const sessionsDir = join(claudeConfigDir(options.env), "sessions");
  for (const pid of collectProcessTreePids(entries, options.rootPid)) {
    const sessionId = await readRunningSessionId(sessionsDir, pid);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}
