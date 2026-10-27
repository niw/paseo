import { Command } from "commander";
import {
  addMcpGatewayHost,
  listMcpGatewayHosts,
  MCP_GATEWAY_MODES,
  type McpGatewayMode,
  parseMcpGatewayToolNames,
  removeMcpGatewayHost,
  type McpGatewayHostListing,
  type McpGatewaySessionOptions,
} from "@getpaseo/server/mcp-gateway";
import {
  renderError,
  toCommandError,
  withOutput,
  type CommandResult,
  type OutputSchema,
} from "../../output/index.js";
import {
  addJsonOption,
  addLocalDaemonOptions,
  withGlobalOptions,
} from "../../utils/command-options.js";
import { resolveCliVersion } from "../../version.js";
import { createMcpDaemonCommand } from "./daemon.js";
import { addConfigOption, configPath, runMcpGateway, type McpCommandOptions } from "./shared.js";

interface Options extends McpCommandOptions {
  label?: string;
  tools?: string;
  mode?: string;
}

const hostSchema: OutputSchema<McpGatewayHostListing> = {
  idField: "serverId",
  columns: [
    { header: "SERVER", field: "serverId" },
    { header: "LABEL", field: "label" },
  ],
};

function stdioSession(options: Options): McpGatewaySessionOptions {
  if (options.mode !== undefined && !MCP_GATEWAY_MODES.includes(options.mode as McpGatewayMode)) {
    throw {
      code: "MCP_GATEWAY_OPTION",
      message: `Unknown mode ${options.mode}. Use ${MCP_GATEWAY_MODES.join(" or ")}.`,
    };
  }
  return {
    ...(options.mode !== undefined ? { mode: options.mode as McpGatewayMode } : {}),
    tools: options.tools !== undefined ? parseMcpGatewayToolNames(options.tools) : null,
  };
}

export function createMcpCommand(): Command {
  const mcp = new Command("mcp").description(
    "Run an MCP gateway that drives agents on several daemons",
  );

  addConfigOption(
    addLocalDaemonOptions(
      mcp
        .command("serve")
        .description(
          "Serve the gateway over stdin/stdout to the MCP client that launched it, with full access",
        )
        .option("--tools <names>", "Comma-separated tools to serve; list_hosts is always included")
        .option(
          "--mode <mode>",
          "tools: one MCP tool per gateway tool (default); exec: a single tool",
        ),
    ),
  ).action(
    withGlobalOptions(async (options: Options, _command: Command) => {
      let session: McpGatewaySessionOptions;
      try {
        session = stdioSession(options);
      } catch (error) {
        process.stderr.write(`${renderError(toCommandError(error))}\n`);
        process.exit(1);
      }
      await runMcpGateway(options, { transport: "stdio", stdio: session });
    }),
  );

  mcp.addCommand(createMcpDaemonCommand());

  const host = new Command("host").description("Manage the daemons the gateway reaches");
  mcp.addCommand(host);

  addConfigOption(
    addJsonOption(addLocalDaemonOptions(host.command("ls").description("List gateway hosts"))),
  ).action(
    withOutput(
      async (
        options: Options,
        _command: Command,
      ): Promise<CommandResult<McpGatewayHostListing>> => ({
        type: "list",
        data: await listMcpGatewayHosts(configPath(options)),
        schema: hostSchema,
      }),
    ),
  );

  addConfigOption(
    addJsonOption(
      addLocalDaemonOptions(
        host
          .command("add")
          .description("Connect once to pin a daemon's server ID, then save the connection")
          .argument("<connection>", "host:port, ws(s) URL, socket, SSH, or pairing URL")
          .option("--label <name>"),
      ),
    ),
  ).action(
    withOutput(
      async (
        connection: string,
        options: Options,
        _command: Command,
      ): Promise<CommandResult<McpGatewayHostListing>> => ({
        type: "single",
        data: await addMcpGatewayHost({
          configPath: configPath(options),
          connection,
          label: options.label,
          appVersion: resolveCliVersion(),
        }),
        schema: hostSchema,
      }),
    ),
  );

  addConfigOption(
    addJsonOption(
      addLocalDaemonOptions(
        host.command("rm").description("Remove a gateway host").argument("<server-id>"),
      ),
    ),
  ).action(
    withOutput(
      async (
        serverId: string,
        options: Options,
        _command: Command,
      ): Promise<CommandResult<McpGatewayHostListing>> => ({
        type: "single",
        data: await removeMcpGatewayHost({ configPath: configPath(options), serverId }),
        schema: hostSchema,
      }),
    ),
  );

  return mcp;
}
