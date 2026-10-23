import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createCloudflareAccessVerifier,
  type CloudflareAccessVerifier,
} from "./cloudflare-access.js";
import type { ExternalMcpPrincipal } from "./config.js";
import { startExternalMcpServer, type ExternalMcpServer } from "./server.js";

const ISSUER = "https://example.cloudflareaccess.com";
const AUDIENCE = "aud-tag-1";
const PRINCIPALS: ExternalMcpPrincipal[] = [
  { match: { kind: "email", value: "niw@niw.at" }, permissions: ["workspace.read"] },
];

let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let verifier: CloudflareAccessVerifier;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  signingKey = keyPair.privateKey;
  const jwk = { ...(await exportJWK(keyPair.publicKey)), kid: "access-1", alg: "RS256" };
  verifier = createCloudflareAccessVerifier({
    issuer: ISSUER,
    audiences: [AUDIENCE],
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
});

function accessToken(payload: JWTPayload = { email: "niw@niw.at" }): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "access-1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

let running: ExternalMcpServer | null = null;
let enabled = true;
const callers: string[] = [];

afterEach(async () => {
  await running?.stop();
  running = null;
  enabled = true;
  callers.length = 0;
});

async function start(): Promise<URL> {
  running = await startExternalMcpServer({
    listenTarget: { type: "tcp", host: "127.0.0.1", port: 0 },
    verifier,
    principals: PRINCIPALS,
    isEnabled: () => enabled,
    createMcpServer: async (caller) => {
      callers.push(caller.principalId);
      const server = new McpServer({ name: "external-test", version: "0.0.0" });
      server.registerTool("whoami", { description: "Returns the caller" }, async () => ({
        content: [{ type: "text", text: `${caller.principalId} ${caller.permissions.join(",")}` }],
      }));
      return server;
    },
    logger: createTestLogger(),
  });
  if (running.listenTarget.type !== "tcp") {
    throw new Error("expected a TCP listener");
  }
  return new URL(`http://127.0.0.1:${running.listenTarget.port}/mcp/agents`);
}

function postInitialize(url: URL, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    }),
  });
}

describe("external MCP listener", () => {
  it("serves tools to a caller with a valid Access token", async () => {
    const url = await start();
    const token = await accessToken();
    const client = new Client({ name: "external-agent", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { "Cf-Access-Jwt-Assertion": token } },
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["whoami"]);
      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(result.content).toEqual([
        { type: "text", text: "cf-access:email:niw@niw.at workspace.read" },
      ]);
    } finally {
      await client.close();
    }
  });

  it("rejects a request without an Access token", async () => {
    const response = await postInitialize(await start());
    expect(response.status).toBe(401);
    expect(callers).toEqual([]);
  });

  it("ignores the Authorization header", async () => {
    const response = await postInitialize(await start(), {
      authorization: `Bearer ${await accessToken()}`,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a token that fails verification", async () => {
    const token = await accessToken();
    const tampered = `${token.slice(0, -4)}AAAA`;
    const response = await postInitialize(await start(), { "cf-access-jwt-assertion": tampered });
    expect(response.status).toBe(401);
  });

  it("forbids a verified identity nobody listed", async () => {
    const token = await accessToken({ email: "someone@example.com" });
    const response = await postInitialize(await start(), { "cf-access-jwt-assertion": token });
    expect(response.status).toBe(403);
    expect(callers).toEqual([]);
  });

  it("refuses to act as a local agent", async () => {
    const url = await start();
    url.searchParams.set("callerAgentId", "agent-1");
    const response = await postInitialize(url, {
      "cf-access-jwt-assertion": await accessToken(),
    });
    expect(response.status).toBe(400);
    expect(callers).toEqual([]);
  });

  it("answers GET with 405 once authenticated", async () => {
    const response = await fetch(await start(), {
      headers: { "cf-access-jwt-assertion": await accessToken() },
    });
    expect(response.status).toBe(405);
  });

  it("returns 404 while daemon MCP is disabled", async () => {
    const url = await start();
    enabled = false;
    const response = await postInitialize(url, {
      "cf-access-jwt-assertion": await accessToken(),
    });
    expect(response.status).toBe(404);
  });

  it("serves nothing but the MCP route", async () => {
    const url = await start();
    const response = await fetch(new URL("/api/status", url), {
      headers: { "cf-access-jwt-assertion": await accessToken() },
    });
    expect(response.status).toBe(404);
  });

  it("answers malformed JSON with a JSON 400", async () => {
    const response = await fetch(await start(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-jwt-assertion": await accessToken(),
      },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Bad request" });
  });
});
