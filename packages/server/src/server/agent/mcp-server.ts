import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolResult } from "./tools/types.js";

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const catalog = await createPaseoToolCatalog(options);
  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  for (const tool of catalog.tools.values()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await catalog.executeTool(tool.name, args, { signal: context?.signal })),
    );
  }

  return server;
}

/**
 * Serves one MCP POST with a server built for this request alone.
 *
 * Stateless mode: each HTTP request builds a fresh server + transport that is
 * torn down when the response closes, so no per-session state is retained between
 * requests. The agent control plane only lists and calls tools, neither of which
 * needs cross-request state, so sessions would only pin memory for the life of the
 * daemon (agents that exit without a clean DELETE never get reaped).
 */
export async function serveStatelessMcpRequest(input: {
  createServer: () => Promise<McpServer>;
  req: IncomingMessage;
  res: ServerResponse;
  body: unknown;
  logger: Logger;
}): Promise<void> {
  const { req, res, logger } = input;
  try {
    const server = await input.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // NOTE: Callers enforce a Vite-like host allowlist or their own
      // authentication before reaching here. The transport's built-in check
      // requires exact Host header matches.
      enableDnsRebindingProtection: false,
    });
    Object.assign(transport, {
      onerror: (err: Error) => {
        logger.error({ err }, "Agent MCP transport error");
      },
    });
    await server.connect(transport);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res, input.body);
  } catch (err) {
    logger.error({ err }, "Failed to handle Agent MCP request");
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error" },
          id: null,
        }),
      );
    }
  }
}
