import type { ProcessEnvRecord } from "../../../paseo-env.js";

// Env vars a running Claude Code session sets for its child processes. When the daemon
// starts from inside Claude Code, they leak into what it spawns, and a Claude Code started
// there acts as a child session: it refuses to launch or skips writing its session file.
export const CLAUDE_PARENT_SESSION_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
] as const;

export function withoutClaudeParentSessionEnv(env: ProcessEnvRecord): ProcessEnvRecord {
  const sanitized = { ...env };
  for (const key of CLAUDE_PARENT_SESSION_ENV_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}
