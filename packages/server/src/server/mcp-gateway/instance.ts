import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import treeKill from "tree-kill";
import type { HttpListenTarget } from "../http-listen.js";
import {
  getPidLockInfo,
  isPidLockOwnerRunning,
  isSamePidLock,
  releasePidLock,
  type PidLockFile,
  type PidLockInfo,
} from "../pid-lock.js";
import { ensurePrivateDirectory } from "../private-files.js";

/** Held by the gateway process serving HTTP, so one home runs one HTTP gateway. */
export const MCP_GATEWAY_PID_LOCK: PidLockFile = {
  name: "mcp-gateway.pid",
  owner: "Paseo MCP gateway",
  subject: "MCP gateway",
};

const MCP_GATEWAY_LOG_FILE = "mcp-gateway.log";
const START_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 30;

export type McpGatewayInstance = PidLockInfo;

export class McpGatewayInstanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpGatewayInstanceError";
  }
}

export function mcpGatewayLogPath(home: string): string {
  return path.join(home, MCP_GATEWAY_LOG_FILE);
}

export function formatMcpGatewayListen(target: HttpListenTarget): string {
  if (target.type !== "tcp") return target.path;
  return target.host.includes(":")
    ? `[${target.host}]:${target.port}`
    : `${target.host}:${target.port}`;
}

/** The running HTTP gateway for a home, or null. A lock left by a dead process does not count. */
export async function readMcpGatewayInstance(home: string): Promise<McpGatewayInstance | null> {
  const lock = await getPidLockInfo(home, { lock: MCP_GATEWAY_PID_LOCK });
  return lock && isPidLockOwnerRunning(lock) ? lock : null;
}

async function logTailSince(logPath: string, offset: number): Promise<string> {
  const log = await readFile(logPath, "utf8").catch(() => "");
  return log.slice(offset).trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n");
}

/**
 * Starts the gateway in the background and waits until it listens. The
 * command must run the gateway serving HTTP for this home, which takes the
 * gateway lock and records its listen address there; that is how this waits.
 * The gateway writes its own rotated log, so its output is not kept here.
 */
export async function startMcpGatewayInstance(input: {
  home: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ instance: McpGatewayInstance; spawned: boolean }> {
  const existing = await readMcpGatewayInstance(input.home);
  if (existing) return { instance: existing, spawned: false };

  ensurePrivateDirectory(input.home);
  const logPath = mcpGatewayLogPath(input.home);
  const logOffset = await stat(logPath).then(
    (info) => info.size,
    () => 0,
  );
  let exit: { code: number | null; error?: Error } | undefined;
  const child = spawn(input.command, input.args, {
    env: input.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", (error) => {
    exit = { code: null, error };
  });
  child.once("exit", (code) => {
    exit ??= { code };
  });
  child.unref();

  const deadline = Date.now() + (input.timeoutMs ?? START_TIMEOUT_MS);
  while (true) {
    const lock = await readMcpGatewayInstance(input.home);
    if (lock && lock.pid !== child.pid) return { instance: lock, spawned: false };
    if (lock?.listen) return { instance: lock, spawned: true };
    if (exit) {
      const reason = exit.error?.message ?? `exit ${exit.code ?? "by signal"}`;
      throw new McpGatewayInstanceError(
        "MCP_GATEWAY_START_FAILED",
        `MCP gateway failed to start (${reason}). Logs: ${logPath}\n${await logTailSince(logPath, logOffset)}`,
      );
    }
    if (Date.now() >= deadline) {
      if (child.pid) await killTree(child.pid);
      throw new McpGatewayInstanceError(
        "MCP_GATEWAY_NOT_READY",
        `MCP gateway did not start listening in time. Logs: ${logPath}`,
      );
    }
    await delay(100);
  }
}

/**
 * Asks the running gateway to exit with SIGTERM and waits for it. On Windows
 * the signal ends the process at once; the gateway keeps no state that needs a
 * graceful exit. With force, a gateway still running at the deadline is killed.
 */
export async function stopMcpGatewayInstance(
  home: string,
  options: { timeoutMs?: number; force?: boolean; killTimeoutMs?: number } = {},
): Promise<{ action: "stopped" | "not_running"; pid: number | null; forced: boolean }> {
  const { timeoutMs = 15_000, killTimeoutMs = 3_000 } = options;
  const lock = await getPidLockInfo(home, { lock: MCP_GATEWAY_PID_LOCK });
  if (!lock || !isPidLockOwnerRunning(lock)) {
    if (lock) {
      await releasePidLock(home, {
        ownerPid: lock.pid,
        startedAt: lock.startedAt,
        lock: MCP_GATEWAY_PID_LOCK,
      });
    }
    return { action: "not_running", pid: lock?.pid ?? null, forced: false };
  }
  if (lock.pid <= 1 || lock.pid === process.pid) {
    throw new McpGatewayInstanceError("MCP_GATEWAY_INVALID_PID", "Refusing to stop an invalid PID");
  }

  async function waitForExit(waitMs: number): Promise<boolean> {
    const exitDeadline = Date.now() + waitMs;
    while (isPidLockOwnerRunning(lock!)) {
      const current = await getPidLockInfo(home, { lock: MCP_GATEWAY_PID_LOCK });
      if (current && !isSamePidLock(current, lock!)) {
        throw new McpGatewayInstanceError(
          "MCP_GATEWAY_REPLACED",
          `Another MCP gateway replaced PID ${lock!.pid} while it was stopping.`,
        );
      }
      if (Date.now() >= exitDeadline) return false;
      await delay(100);
    }
    return true;
  }

  try {
    process.kill(lock.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  let forced = false;
  let stopped = await waitForExit(timeoutMs);
  if (!stopped && options.force) {
    await killTree(lock.pid);
    forced = true;
    stopped = await waitForExit(killTimeoutMs);
  }
  if (!stopped) {
    throw new McpGatewayInstanceError(
      "MCP_GATEWAY_STOP_NOT_CONFIRMED",
      `MCP gateway PID ${lock.pid} did not exit in time${options.force ? "" : "; use --force to kill it"}.`,
    );
  }
  await releasePidLock(home, {
    ownerPid: lock.pid,
    startedAt: lock.startedAt,
    lock: MCP_GATEWAY_PID_LOCK,
  });
  return { action: "stopped", pid: lock.pid, forced };
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, "SIGKILL", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
