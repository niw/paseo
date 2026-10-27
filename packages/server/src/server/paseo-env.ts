import path from "node:path";

const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const RUNTIME_CONTROL_ENV_KEYS = [
  PASEO_NODE_ENV,
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ESBUILD_BINARY_PATH",
] as const;

// npm and npx export their resolved config to every child as npm_config_* and prepend
// node_modules/.bin dirs to PATH. When the daemon is launched through npm (`npx paseo`),
// those values would shadow the .npmrc of every project an agent or setup script runs npm in.
const NPM_RUN_SCRIPT_PATH_MARKER = /[\\/]@npmcli[\\/]run-script[\\/]lib[\\/]node-gyp-bin$/;

export type PaseoNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  return { ...baseEnv };
}

function stripPathEntriesAddedByNpm(value: string): string {
  const entries = value.split(path.delimiter);
  // npm places its node-gyp-bin dir right after the dirs it prepends, so everything up to the
  // last marker came from npm (the last one, because npm-in-npm stacks prefixes).
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (NPM_RUN_SCRIPT_PATH_MARKER.test(entries[index])) {
      return entries.slice(index + 1).join(path.delimiter);
    }
  }
  return value;
}

function withoutInheritedNpmEnv(baseEnv: ProcessEnvRecord): ProcessEnvRecord {
  if (!baseEnv.npm_execpath) {
    return baseEnv;
  }
  const env: ProcessEnvRecord = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (/^npm_/i.test(key) || key === "INIT_CWD") {
      continue;
    }
    if (key === "NODE" && value === baseEnv.npm_node_execpath) {
      continue;
    }
    env[key] = /^path$/i.test(key) && value ? stripPathEntriesAddedByNpm(value) : value;
  }
  return env;
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  const sanitized = Object.assign({}, withoutInheritedNpmEnv(baseEnv), ...overlays);
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

export function createPaseoInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  // Deprecated command parameter: retained while callers migrate to createExternalProcessEnv.
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function buildSelfNodeCommand(
  args: string[],
  envOverlay?: ProcessEnvRecord,
): {
  command: string;
  args: string[];
  env: ExternalProcessEnv;
} {
  const env = buildExternalProcessEnv(process.env, []);
  Object.assign(env, { [ELECTRON_RUN_AS_NODE]: "1" }, envOverlay);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return {
    command: process.execPath,
    args,
    env,
  };
}

export function resolvePaseoNodeEnv(env: NodeJS.ProcessEnv): PaseoNodeEnv | undefined {
  const value = env[PASEO_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}
