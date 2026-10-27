import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pino, { type Logger } from "pino";
import { createStream as createRotatingFileStream } from "rotating-file-stream";
import { parseListenString, type HttpListenTarget } from "../http-listen.js";
import {
  acquirePidLock,
  PidLockError,
  releasePidLock,
  startPidLockHeartbeat,
  updatePidLock,
} from "../pid-lock.js";
import { createCloudflareAccessVerifier } from "./cloudflare-access.js";
import {
  loadMcpGatewayConfig,
  McpGatewayConfigError,
  resolveMcpGatewayHttpConfig,
  type McpGatewayHttpConfig,
  saveMcpGatewayConfig,
} from "./config.js";
import { startMcpGatewayHttpServer } from "./http.js";
import {
  createMcpGatewayHosts,
  identifyMcpGatewayHost,
  type McpGatewayClientIdentity,
} from "./hosts.js";
import {
  formatMcpGatewayListen,
  MCP_GATEWAY_PID_LOCK,
  McpGatewayInstanceError,
} from "./instance.js";
import { createMcpGatewayServer, type McpGatewaySessionOptions } from "./tools.js";

export { McpGatewayConfigError, resolveMcpGatewayConfigPath } from "./config.js";
export type { McpGatewayClientIdentity } from "./hosts.js";
export { parseMcpGatewayToolNames } from "./tool-policy.js";
export { MCP_GATEWAY_MODES, type McpGatewayMode, type McpGatewaySessionOptions } from "./tools.js";
export { MCP_GATEWAY_ROUTE } from "./http.js";
export {
  mcpGatewayLogPath,
  McpGatewayInstanceError,
  readMcpGatewayInstance,
  startMcpGatewayInstance,
  stopMcpGatewayInstance,
  type McpGatewayInstance,
} from "./instance.js";

export interface McpGatewayHostListing {
  serverId: string;
  label: string;
}

export interface McpGateway {
  /** The bound HTTP listener, or null when serving stdio. */
  listenTarget: HttpListenTarget | null;
  /** Settles when the stdio client disconnects. Never settles for HTTP. */
  closed: Promise<void>;
  stop(): Promise<void>;
}

export interface StartMcpGatewayOptions {
  configPath: string;
  transport: "http" | "stdio";
  identity: McpGatewayClientIdentity;
  /** Session options for stdio. HTTP callers choose theirs in the MCP URL. */
  stdio?: McpGatewaySessionOptions;
  /**
   * Paseo home whose gateway lock an HTTP gateway holds while it runs, so one
   * home runs one HTTP gateway and `paseo mcp daemon` can find it. stdio
   * gateways take no lock; several can run at once.
   */
  lockHome?: string;
  /** Defaults to a stderr logger, which keeps stdout free for the stdio protocol. */
  logger?: Logger;
  /**
   * Also log to this file, rotated like daemon.log. A background gateway has
   * no terminal, so this is where its logs, including why it failed to start,
   * end up.
   */
  logFile?: string;
}

// The same rotation daemon.log gets by default.
const LOG_ROTATE_SIZE = "10M";
const LOG_ROTATE_MAX_FILES = 3;

interface GatewayLog {
  logger: Logger;
  close(): Promise<void>;
}

function createGatewayLog(options: StartMcpGatewayOptions): GatewayLog {
  if (options.logger) return { logger: options.logger, close: async () => {} };
  const stderr = pino.destination(2);
  if (!options.logFile) return { logger: pino({ level: "info" }, stderr), close: async () => {} };
  const file = createRotatingFileStream(path.basename(options.logFile), {
    path: path.dirname(options.logFile),
    size: LOG_ROTATE_SIZE,
    maxFiles: LOG_ROTATE_MAX_FILES,
  });
  // Logging is best effort: a full disk must not stop the gateway.
  file.on("error", () => {});
  return {
    logger: pino({ level: "info" }, pino.multistream([{ stream: stderr }, { stream: file }])),
    close: () => new Promise((resolve) => file.end(() => resolve())),
  };
}

/**
 * Runs the gateway: an MCP server whose tools act on the configured daemons
 * through ordinary client connections. HTTP serves remote agents behind
 * Cloudflare Access with per-principal permissions; stdio serves the local
 * process that launched it with full access.
 */
export async function startMcpGateway(options: StartMcpGatewayOptions): Promise<McpGateway> {
  const log = createGatewayLog(options);
  let gateway: McpGateway;
  try {
    gateway = await startWithLogger(options, log.logger);
  } catch (error) {
    log.logger.error({ err: error }, "MCP gateway failed to start");
    await log.close();
    throw error;
  }
  return {
    ...gateway,
    async stop() {
      await gateway.stop();
      await log.close();
    },
  };
}

async function startWithLogger(
  options: StartMcpGatewayOptions,
  logger: Logger,
): Promise<McpGateway> {
  const config = await loadMcpGatewayConfig(options.configPath);
  const entries = config.hosts ?? [];
  let http: McpGatewayHttpConfig | null = null;
  if (options.transport === "http") {
    if (!config.http) {
      throw new McpGatewayConfigError(
        `${options.configPath} has no http section. Add listen, cloudflareAccess and principals.`,
      );
    }
    http = resolveMcpGatewayHttpConfig(config.http, new Set(entries.map((host) => host.serverId)));
  }
  if (entries.length === 0) {
    logger.warn("MCP gateway has no hosts; add one with `paseo mcp host add`");
  }
  const hosts = createMcpGatewayHosts({
    hosts: entries,
    identity: options.identity,
    reload: async () => (await loadMcpGatewayConfig(options.configPath)).hosts ?? [],
    onReloadError: (err) => {
      logger.warn({ err }, "Could not reread MCP gateway hosts; keeping the hosts in effect");
    },
  });

  if (!http) {
    const server = createMcpGatewayServer({ hosts, caller: null, options: options.stdio });
    const transport = new StdioServerTransport();
    const closed = new Promise<void>((resolve) => {
      Object.assign(server.server, { onclose: resolve });
      process.stdin.once("end", resolve);
    });
    await server.connect(transport);
    return {
      listenTarget: null,
      closed,
      async stop() {
        await server.close();
        await hosts.close();
      },
    };
  }

  if (http.principals.length === 0) {
    logger.warn("MCP gateway has no principals configured; every request will be rejected");
  }
  const lockHome = options.lockHome;
  if (lockHome) {
    try {
      await acquirePidLock(lockHome, null, { lock: MCP_GATEWAY_PID_LOCK });
    } catch (error) {
      await hosts.close();
      if (!(error instanceof PidLockError)) throw error;
      throw new McpGatewayInstanceError("MCP_GATEWAY_RUNNING", error.message);
    }
  }
  const releaseLock = async () => {
    if (lockHome) await releasePidLock(lockHome, { lock: MCP_GATEWAY_PID_LOCK });
  };
  const listener = await startMcpGatewayHttpServer({
    listenTarget: parseListenString(http.listen),
    verifier: createCloudflareAccessVerifier(http.cloudflareAccess),
    principals: http.principals,
    createMcpServer: (caller, session) =>
      createMcpGatewayServer({ hosts, caller, options: session }),
    logger,
  }).catch(async (error: unknown) => {
    await hosts.close();
    await releaseLock();
    throw error;
  });
  let stopHeartbeat = () => {};
  if (lockHome) {
    await updatePidLock(
      lockHome,
      { listen: formatMcpGatewayListen(listener.listenTarget), serverId: null },
      { lock: MCP_GATEWAY_PID_LOCK },
    );
    stopHeartbeat = startPidLockHeartbeat(lockHome, {
      lock: MCP_GATEWAY_PID_LOCK,
      onError: (err) => logger.warn({ err }, "MCP gateway lock heartbeat failed"),
    });
  }
  logger.info(
    { listen: listener.listenTarget, issuer: http.cloudflareAccess.issuer, hosts: entries.length },
    "MCP gateway listening",
  );
  return {
    listenTarget: listener.listenTarget,
    closed: new Promise<void>(() => {}),
    async stop() {
      stopHeartbeat();
      await listener.stop();
      await hosts.close();
      await releaseLock();
    },
  };
}

export async function listMcpGatewayHosts(configPath: string): Promise<McpGatewayHostListing[]> {
  const config = await loadMcpGatewayConfig(configPath);
  return (config.hosts ?? []).map(toListing);
}

/** Connects once to pin the host's server ID, then saves the connection. */
export async function addMcpGatewayHost(input: {
  configPath: string;
  connection: string;
  label?: string;
  appVersion?: string;
}): Promise<McpGatewayHostListing> {
  const config = await loadMcpGatewayConfig(input.configPath);
  const serverId = await identifyMcpGatewayHost({
    connection: input.connection,
    appVersion: input.appVersion,
  });
  const hosts = config.hosts ?? [];
  if (hosts.some((host) => host.serverId === serverId)) {
    throw new McpGatewayConfigError(`host ${serverId} is already added; remove it first`);
  }
  const entry = {
    serverId,
    ...(input.label ? { label: input.label } : {}),
    connection: input.connection,
  };
  await saveMcpGatewayConfig(input.configPath, { ...config, hosts: [...hosts, entry] });
  return toListing(entry);
}

export async function removeMcpGatewayHost(input: {
  configPath: string;
  serverId: string;
}): Promise<McpGatewayHostListing> {
  const config = await loadMcpGatewayConfig(input.configPath);
  const hosts = config.hosts ?? [];
  const entry = hosts.find((host) => host.serverId === input.serverId);
  if (!entry) {
    throw new McpGatewayConfigError(`host ${input.serverId} is not configured`);
  }
  const principal = config.http?.principals?.find((candidate) =>
    candidate.hosts?.includes(input.serverId),
  );
  if (principal) {
    const name = "email" in principal ? principal.email : principal.commonName;
    throw new McpGatewayConfigError(
      `principal ${name} still lists host ${input.serverId}; remove it from http.principals first`,
    );
  }
  await saveMcpGatewayConfig(input.configPath, {
    ...config,
    hosts: hosts.filter((host) => host !== entry),
  });
  return toListing(entry);
}

function toListing(entry: { serverId: string; label?: string }): McpGatewayHostListing {
  return { serverId: entry.serverId, label: entry.label ?? entry.serverId };
}
