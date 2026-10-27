import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { DaemonPermission } from "@getpaseo/protocol/messages";
import { toMcpToolResult } from "../agent/mcp-server.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerCheckoutTools } from "./checkout-tools.js";
import { registerMcpGatewayExecTool } from "./exec-tool.js";
import { registerFileTools } from "./file-tools.js";
import type { McpGatewayHosts } from "./hosts.js";
import { registerProviderTools } from "./provider-tools.js";
import { registerScheduleTools } from "./schedule-tools.js";
import type { McpGatewayToolEffect, McpGatewayToolName } from "./tool-policy.js";
import { createMcpGatewayToolRegistry, structured, type McpGatewayTool } from "./tool-registry.js";
import { registerTerminalTools } from "./terminal-tools.js";
import { registerWorkspaceTools } from "./workspace-tools.js";

/** null is the local stdio caller, which may use every tool on every host. */
export interface McpGatewayCaller {
  permissions: readonly DaemonPermission[];
  /** null reaches every configured host. */
  hosts: readonly string[] | null;
}

export const MCP_GATEWAY_MODES = ["tools", "exec"] as const;

/** tools publishes one MCP tool per gateway tool; exec publishes a single tool that runs them all. */
export type McpGatewayMode = (typeof MCP_GATEWAY_MODES)[number];

export interface McpGatewaySessionOptions {
  /** Defaults to tools. */
  mode?: McpGatewayMode;
  /** Only these tools, plus list_hosts. null or omitted is every tool the caller may use. */
  tools?: readonly McpGatewayToolName[] | null;
}

function annotationsFor(effect: McpGatewayToolEffect): ToolAnnotations {
  return effect === "read"
    ? { readOnlyHint: true }
    : { readOnlyHint: false, destructiveHint: effect === "destructive" };
}

/** The tools one caller may use in this session, before they are published over MCP. */
export function createMcpGatewayCatalog(input: {
  hosts: McpGatewayHosts;
  caller: McpGatewayCaller | null;
  options?: McpGatewaySessionOptions;
}): McpGatewayTool[] {
  const { hosts, caller, options } = input;
  const registry = createMcpGatewayToolRegistry({
    hosts,
    permissions: caller ? new Set(caller.permissions) : null,
    reachable: caller?.hosts ? new Set(caller.hosts) : null,
    selected: options?.tools ? new Set(options.tools) : null,
  });

  registry.tool(
    "list_hosts",
    {
      title: "List hosts",
      description: "List the hosts this gateway can reach. Pass a serverId to every other tool.",
      inputSchema: {},
    },
    async () =>
      toMcpToolResult(
        structured({
          hosts: (await hosts.list()).filter((host) => registry.reaches(host.serverId)),
        }),
      ),
  );
  registerWorkspaceTools(registry);
  registerAgentTools(registry);
  registerTerminalTools(registry);
  registerScheduleTools(registry);
  registerProviderTools(registry);
  registerCheckoutTools(registry);
  registerFileTools(registry);

  return registry.tools();
}

/**
 * Builds the gateway's MCP server for one caller. Every tool but list_hosts
 * names its destination host; there is no local host to default to.
 */
export function createMcpGatewayServer(input: {
  hosts: McpGatewayHosts;
  caller: McpGatewayCaller | null;
  options?: McpGatewaySessionOptions;
}): McpServer {
  const server = new McpServer({ name: "paseo-mcp-gateway", version: "1.0.0" });
  const catalog = createMcpGatewayCatalog(input);
  if (input.options?.mode === "exec") {
    registerMcpGatewayExecTool(server, catalog);
    return server;
  }
  for (const tool of catalog) {
    // The SDK has validated args against inputSchema before calling.
    const callback = ((args: Record<string, unknown>) => tool.run(args)) as ToolCallback<
      typeof tool.inputSchema
    >;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: annotationsFor(tool.effect),
      },
      callback,
    );
  }
  return server;
}
