import type { Command } from "commander";
import {
  resolveMcpGatewayConfigPath,
  startMcpGateway,
  type StartMcpGatewayOptions,
} from "@getpaseo/server/mcp-gateway";
import { renderError, toCommandError, type CommandOptions } from "../../output/index.js";
import { getOrCreateMcpGatewayClientId } from "../../utils/client-id.js";
import { resolveCliVersion } from "../../version.js";

export interface McpCommandOptions extends CommandOptions {
  config?: string;
}

export function localHome(options: McpCommandOptions): string {
  if (options.daemonTarget.kind !== "instance") throw new Error("The MCP gateway is local");
  return options.daemonTarget.home;
}

export function configPath(options: McpCommandOptions): string {
  return options.config ?? resolveMcpGatewayConfigPath(localHome(options));
}

export function addConfigOption<T extends Command>(command: T): T {
  command.option("--config <path>", "Gateway config file (default: <home>/mcp-gateway.json)");
  return command;
}

/** Runs the gateway in this process until its stdio client leaves or the process is signalled. */
export async function runMcpGateway(
  options: McpCommandOptions,
  gateway: Pick<StartMcpGatewayOptions, "transport" | "stdio" | "logFile">,
): Promise<void> {
  try {
    const running = await startMcpGateway({
      ...gateway,
      configPath: configPath(options),
      lockHome: localHome(options),
      identity: {
        clientId: await getOrCreateMcpGatewayClientId(localHome(options)),
        appVersion: resolveCliVersion(),
      },
    });
    const signal = new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await Promise.race([running.closed, signal]);
    await running.stop();
  } catch (error) {
    process.stderr.write(`${renderError(toCommandError(error))}\n`);
    process.exit(1);
  }
  // Daemon clients may still hold reconnect timers; the gateway has stopped.
  process.exit(0);
}
