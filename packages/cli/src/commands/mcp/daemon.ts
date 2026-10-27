import path from "node:path";
import { Command } from "commander";
import {
  MCP_GATEWAY_ROUTE,
  mcpGatewayLogPath,
  readMcpGatewayInstance,
  startMcpGatewayInstance,
  stopMcpGatewayInstance,
} from "@getpaseo/server/mcp-gateway";
import { withOutput, type SingleResult } from "../../output/index.js";
import {
  addJsonOption,
  addLocalDaemonOptions,
  withGlobalOptions,
} from "../../utils/command-options.js";
import { parseTimeoutMs } from "../daemon/local-daemon.js";
import {
  addConfigOption,
  configPath,
  localHome,
  runMcpGateway,
  type McpCommandOptions,
} from "./shared.js";

interface Options extends McpCommandOptions {
  timeout?: string;
  force?: boolean;
  killTimeout?: string;
}

interface GatewayState {
  action?: string;
  status: "running" | "stopped";
  pid: number | null;
  startedAt?: string;
  listen?: string | null;
  endpoint?: string | null;
  logPath: string;
  configPath?: string;
}

function endpointFor(listen: string | null | undefined): string | null {
  return listen && !listen.startsWith("/") && !listen.startsWith("\\")
    ? `http://${listen}${MCP_GATEWAY_ROUTE}`
    : null;
}

function result(state: GatewayState, human: string): SingleResult<GatewayState> {
  return {
    type: "single",
    data: state,
    schema: { idField: "status", columns: [], renderHuman: () => human },
  };
}

async function start(options: Options): Promise<SingleResult<GatewayState>> {
  const home = localHome(options);
  // Run this same CLI again as `mcp daemon run`: execArgv keeps how it was
  // launched, such as tsx running the source.
  const serveArgs = [
    process.argv[1]!,
    "mcp",
    "daemon",
    "run",
    "--home",
    home,
    ...(options.config ? ["--config", path.resolve(options.config)] : []),
  ];
  const { instance, spawned } = await startMcpGatewayInstance({
    home,
    command: process.execPath,
    args: [...process.execArgv, ...serveArgs],
    env: process.env,
    timeoutMs: parseTimeoutMs(options.timeout, 60_000),
  });
  const endpoint = endpointFor(instance.listen);
  return result(
    {
      action: spawned ? "started" : "already_running",
      status: "running",
      pid: instance.pid,
      startedAt: instance.startedAt,
      listen: instance.listen,
      endpoint,
      logPath: mcpGatewayLogPath(home),
    },
    `MCP gateway ${spawned ? "started" : "already running"} (PID ${instance.pid}) on ${instance.listen ?? "?"}${endpoint ? `\nEndpoint: ${endpoint}` : ""}`,
  );
}

async function stop(options: Options): Promise<SingleResult<GatewayState>> {
  const home = localHome(options);
  const stopped = await stopMcpGatewayInstance(home, {
    timeoutMs: parseTimeoutMs(options.timeout, 15_000),
    force: options.force === true,
    killTimeoutMs: parseTimeoutMs(options.killTimeout, 3_000),
  });
  return result(
    {
      action: stopped.action,
      status: "stopped",
      pid: stopped.pid,
      logPath: mcpGatewayLogPath(home),
    },
    stopped.action === "stopped"
      ? `MCP gateway stopped (PID ${stopped.pid}${stopped.forced ? ", killed" : ""})`
      : "MCP gateway is not running",
  );
}

async function status(options: Options): Promise<SingleResult<GatewayState>> {
  const home = localHome(options);
  const instance = await readMcpGatewayInstance(home);
  const state: GatewayState = {
    status: instance ? "running" : "stopped",
    pid: instance?.pid ?? null,
    ...(instance ? { startedAt: instance.startedAt, listen: instance.listen } : {}),
    endpoint: endpointFor(instance?.listen),
    logPath: mcpGatewayLogPath(home),
    configPath: configPath(options),
  };
  const lines = instance
    ? [
        `status: running (PID ${instance.pid}, since ${instance.startedAt})`,
        `listen: ${instance.listen ?? "starting"}`,
        ...(state.endpoint ? [`endpoint: ${state.endpoint}`] : []),
      ]
    : ["status: stopped"];
  return result(
    state,
    [...lines, `config: ${state.configPath}`, `log: ${state.logPath}`].join("\n"),
  );
}

function withTimeout<T extends Command>(command: T, defaultSeconds: number): T {
  command.option("--timeout <seconds>", `Deadline in seconds (default: ${defaultSeconds})`);
  return command;
}

/** Runs the HTTP gateway in the background, the way `paseo daemon` runs the daemon. */
export function createMcpDaemonCommand(): Command {
  const daemon = new Command("daemon").description(
    "Run the HTTP gateway for agents on other machines, behind Cloudflare Access",
  );

  addConfigOption(
    addLocalDaemonOptions(
      daemon.command("run").description("Run the HTTP gateway in the foreground"),
    ),
  ).action(
    withGlobalOptions((options: Options, _command: Command) =>
      runMcpGateway(options, { transport: "http", logFile: mcpGatewayLogPath(localHome(options)) }),
    ),
  );

  addConfigOption(
    addJsonOption(
      addLocalDaemonOptions(
        withTimeout(
          daemon.command("start").description("Start the HTTP gateway in the background"),
          60,
        ),
      ),
    ),
  ).action(withOutput((options: Options, _command: Command) => start(options)));

  addJsonOption(
    addLocalDaemonOptions(
      withTimeout(daemon.command("stop").description("Stop the background HTTP gateway"), 15)
        .option("--force", "Kill the gateway if it has not exited by the deadline")
        .option("--kill-timeout <seconds>", "Deadline after killing it (default: 3)"),
    ),
  ).action(withOutput((options: Options, _command: Command) => stop(options)));

  addConfigOption(
    addJsonOption(
      addLocalDaemonOptions(
        withTimeout(
          daemon
            .command("restart")
            .description("Stop the background HTTP gateway and start it again"),
          60,
        ).option("--force", "Kill the gateway if it has not exited within 15 seconds"),
      ),
    ),
  ).action(
    withOutput(async (options: Options, _command: Command) => {
      await stop({ ...options, timeout: undefined });
      return start(options);
    }),
  );

  addConfigOption(
    addJsonOption(
      addLocalDaemonOptions(
        daemon.command("status").description("Show the background HTTP gateway"),
      ),
    ),
  ).action(withOutput((options: Options, _command: Command) => status(options)));

  return daemon;
}
