import { createServer as createHTTPServer } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import type { Logger } from "pino";

import { serveStatelessMcpRequest } from "../agent/mcp-server.js";
import {
  closeHttpServer,
  listenHttpServer,
  resolveBoundListenTarget,
  type HttpListenTarget,
} from "../http-listen.js";
import {
  CLOUDFLARE_ACCESS_JWT_HEADER,
  resolveMcpGatewayPrincipal,
  type CloudflareAccessVerifier,
  type ResolvedMcpGatewayPrincipal,
} from "./cloudflare-access.js";
import type { McpGatewayPrincipal } from "./config.js";
import { McpGatewayToolNameError, parseMcpGatewayToolNames } from "./tool-policy.js";
import { MCP_GATEWAY_MODES, type McpGatewayMode, type McpGatewaySessionOptions } from "./tools.js";

// The same path as the daemon's Agent MCP, so a remote agent's MCP URL
// does not change when it moves from a daemon to the gateway.
export const MCP_GATEWAY_ROUTE = "/mcp/agents";

export interface McpGatewayHttpServerOptions {
  listenTarget: HttpListenTarget;
  verifier: CloudflareAccessVerifier;
  principals: readonly McpGatewayPrincipal[];
  createMcpServer: (
    caller: ResolvedMcpGatewayPrincipal,
    session: McpGatewaySessionOptions,
  ) => McpServer;
  logger: Logger;
}

export interface McpGatewayHttpServer {
  listenTarget: HttpListenTarget;
  stop(): Promise<void>;
}

/**
 * Serves the gateway tools behind Cloudflare Access. cloudflared reaches the
 * listener over loopback, so the source address proves nothing: the Access JWT
 * is the only way in.
 */
export async function startMcpGatewayHttpServer(
  options: McpGatewayHttpServerOptions,
): Promise<McpGatewayHttpServer> {
  const logger = options.logger.child({ module: "mcp-gateway" });
  const app = express();
  app.disable("x-powered-by");

  // Authenticate before parsing the body so unauthenticated callers cannot make
  // the gateway read their payloads.
  app.all(
    MCP_GATEWAY_ROUTE,
    (req, res, next) => {
      void requireCaller(req, res, next);
    },
    express.json(),
    (req, res) => {
      void handleRequest(req, res, res.locals.caller as ResolvedMcpGatewayPrincipal);
    },
  );
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = readHttpErrorStatus(err);
      if (status >= 500) {
        logger.error({ err }, "MCP gateway request failed");
      }
      res.status(status).json({ error: status >= 500 ? "Internal error" : "Bad request" });
    },
  );

  async function handleRequest(
    req: express.Request,
    res: express.Response,
    caller: ResolvedMcpGatewayPrincipal,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
      return;
    }
    let session: McpGatewaySessionOptions;
    try {
      session = readSessionOptions(req.query);
    } catch (error) {
      if (
        !(error instanceof McpGatewayToolNameError) &&
        !(error instanceof McpGatewaySessionOptionsError)
      ) {
        throw error;
      }
      res.status(400).json({ error: error.message });
      return;
    }
    logToolCalls(caller, req.body);
    await serveStatelessMcpRequest({
      createServer: async () => options.createMcpServer(caller, session),
      req,
      res,
      body: req.body,
      logger,
    });
  }

  async function requireCaller(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> {
    let caller: ResolvedMcpGatewayPrincipal | null;
    try {
      caller = await authenticate(req, res);
    } catch (err) {
      next(err);
      return;
    }
    if (caller) {
      res.locals.caller = caller;
      next();
    }
  }

  async function authenticate(
    req: express.Request,
    res: express.Response,
  ): Promise<ResolvedMcpGatewayPrincipal | null> {
    const token = req.header(CLOUDFLARE_ACCESS_JWT_HEADER);
    if (!token) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    const identity = await options.verifier.verify(token).catch((err: unknown) => {
      logger.warn({ err }, "Rejected MCP gateway request with an invalid Access token");
      return null;
    });
    if (!identity) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    const caller = resolveMcpGatewayPrincipal(identity, options.principals);
    if (!caller) {
      logger.warn({ identity }, "Rejected MCP gateway request from an unlisted identity");
      res.status(403).json({ error: "Forbidden" });
      return null;
    }
    return caller;
  }

  function logToolCalls(caller: ResolvedMcpGatewayPrincipal, body: unknown): void {
    for (const message of Array.isArray(body) ? body : [body]) {
      if (!isToolCall(message)) {
        continue;
      }
      logger.info(
        { principalId: caller.principalId, tool: message.params.name },
        "MCP gateway tool call",
      );
    }
  }

  const server = createHTTPServer(app);
  await listenHttpServer(server, options.listenTarget);
  const listenTarget = resolveBoundListenTarget(options.listenTarget, server);
  return {
    listenTarget,
    stop: () => closeHttpServer(server, listenTarget),
  };
}

class McpGatewaySessionOptionsError extends Error {}

/** Session options come from the MCP URL, such as /mcp/agents?mode=exec&tools=list_agents. */
function readSessionOptions(query: express.Request["query"]): McpGatewaySessionOptions {
  const tools = typeof query.tools === "string" ? parseMcpGatewayToolNames(query.tools) : null;
  const mode = query.mode;
  if (mode !== undefined && !MCP_GATEWAY_MODES.includes(mode as McpGatewayMode)) {
    throw new McpGatewaySessionOptionsError(
      `Unknown mode ${String(mode)}. Use ${MCP_GATEWAY_MODES.join(" or ")}.`,
    );
  }
  return { tools, ...(mode !== undefined ? { mode: mode as McpGatewayMode } : {}) };
}

function isToolCall(value: unknown): value is { params: { name: string } } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as { method?: unknown; params?: { name?: unknown } };
  return message.method === "tools/call" && typeof message.params?.name === "string";
}

function readHttpErrorStatus(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}
