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
  resolveExternalPrincipal,
  type CloudflareAccessVerifier,
  type ResolvedExternalPrincipal,
} from "./cloudflare-access.js";
import type { ExternalMcpPrincipal } from "./config.js";

export const EXTERNAL_MCP_ROUTE = "/mcp/agents";

export interface ExternalMcpServerOptions {
  listenTarget: HttpListenTarget;
  verifier: CloudflareAccessVerifier;
  principals: readonly ExternalMcpPrincipal[];
  /** Follows daemon.mcp.enabled, which can change while the daemon runs. */
  isEnabled: () => boolean;
  createMcpServer: (caller: ResolvedExternalPrincipal) => Promise<McpServer>;
  logger: Logger;
}

export interface ExternalMcpServer {
  listenTarget: HttpListenTarget;
  stop(): Promise<void>;
}

/**
 * Serves the Agent MCP tools to agents outside this machine, behind Cloudflare
 * Access. It runs on its own listener because cloudflared reaches the daemon
 * over loopback: on the main listener a tunneled request is indistinguishable
 * from a local agent, and would fall through to the password, capability-token
 * and callerAgentId paths. Here the Access JWT is the only way in.
 */
export async function startExternalMcpServer(
  options: ExternalMcpServerOptions,
): Promise<ExternalMcpServer> {
  const logger = options.logger.child({ module: "external-mcp" });
  const app = express();
  app.disable("x-powered-by");

  // Authenticate before parsing the body so unauthenticated callers cannot make
  // the daemon read their payloads.
  app.all(
    EXTERNAL_MCP_ROUTE,
    (req, res, next) => {
      void requireCaller(req, res, next);
    },
    express.json(),
    (req, res) => {
      void handleRequest(req, res, res.locals.caller as ResolvedExternalPrincipal);
    },
  );
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = readHttpErrorStatus(err);
      if (status >= 500) {
        logger.error({ err }, "External MCP request failed");
      }
      res.status(status).json({ error: status >= 500 ? "Internal error" : "Bad request" });
    },
  );

  async function handleRequest(
    req: express.Request,
    res: express.Response,
    caller: ResolvedExternalPrincipal,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
      return;
    }
    // External callers are never agent-scoped. Accepting the parameter would
    // let them act as a local agent: inherit its cwd and policy, own its
    // heartbeats and receive its notifications.
    if (req.query.callerAgentId !== undefined) {
      res.status(400).json({ error: "callerAgentId is not accepted from external callers" });
      return;
    }
    logToolCalls(caller, req.body);
    await serveStatelessMcpRequest({
      createServer: () => options.createMcpServer(caller),
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
    let caller: ResolvedExternalPrincipal | null;
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
  ): Promise<ResolvedExternalPrincipal | null> {
    if (!options.isEnabled()) {
      res.status(404).json({ error: "Agent MCP endpoint disabled" });
      return null;
    }
    const token = req.header(CLOUDFLARE_ACCESS_JWT_HEADER);
    if (!token) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    const identity = await options.verifier.verify(token).catch((err: unknown) => {
      logger.warn({ err }, "Rejected external MCP request with an invalid Access token");
      return null;
    });
    if (!identity) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    const caller = resolveExternalPrincipal(identity, options.principals);
    if (!caller) {
      logger.warn({ identity }, "Rejected external MCP request from an unlisted identity");
      res.status(403).json({ error: "Forbidden" });
      return null;
    }
    return caller;
  }

  function logToolCalls(caller: ResolvedExternalPrincipal, body: unknown): void {
    for (const message of Array.isArray(body) ? body : [body]) {
      if (!isToolCall(message)) {
        continue;
      }
      logger.info(
        { principalId: caller.principalId, tool: message.params.name },
        "External MCP tool call",
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
