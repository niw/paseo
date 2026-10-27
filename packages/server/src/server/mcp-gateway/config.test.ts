import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadMcpGatewayConfig,
  McpGatewayConfigError,
  McpGatewayConfigSchema,
  resolveMcpGatewayHttpConfig,
  saveMcpGatewayConfig,
} from "./config.js";

const HTTP = {
  listen: "127.0.0.1:6769",
  cloudflareAccess: { teamDomain: "example.cloudflareaccess.com", aud: ["aud-1"] },
  principals: [{ email: "niw@niw.at", permissions: ["workspace.read", "workspace.write"] }],
};
const HOST_IDS = new Set(["server-a", "server-b"]);

function resolve(http: unknown) {
  const parsed = McpGatewayConfigSchema.parse({ http });
  return resolveMcpGatewayHttpConfig(parsed.http!, HOST_IDS);
}

describe("MCP gateway HTTP config", () => {
  it("resolves the listener, issuer and principals", () => {
    expect(resolve(HTTP)).toEqual({
      listen: "127.0.0.1:6769",
      cloudflareAccess: { issuer: "https://example.cloudflareaccess.com", audiences: ["aud-1"] },
      principals: [
        {
          match: { kind: "email", value: "niw@niw.at" },
          permissions: ["workspace.read", "workspace.write"],
          hosts: null,
        },
      ],
    });
  });

  it("accepts a team domain written as a URL", () => {
    const resolved = resolve({
      ...HTTP,
      cloudflareAccess: { teamDomain: "https://example.cloudflareaccess.com/", aud: ["aud-1"] },
    });
    expect(resolved.cloudflareAccess.issuer).toBe("https://example.cloudflareaccess.com");
  });

  it("keeps a principal's host list", () => {
    const resolved = resolve({
      ...HTTP,
      principals: [
        { commonName: "client.access", permissions: ["workspace.read"], hosts: ["server-b"] },
      ],
    });
    expect(resolved.principals[0]?.hosts).toEqual(["server-b"]);
  });

  it.each([
    ["Cloudflare Access is not set up", { listen: "127.0.0.1:6769" }],
    [
      "the team domain has a path",
      {
        ...HTTP,
        cloudflareAccess: { teamDomain: "example.cloudflareaccess.com/certs", aud: ["aud-1"] },
      },
    ],
    [
      "the team domain is not https",
      {
        ...HTTP,
        cloudflareAccess: { teamDomain: "http://example.cloudflareaccess.com", aud: ["aud-1"] },
      },
    ],
    [
      "a principal reaches no host tool",
      { ...HTTP, principals: [{ commonName: "client.access", permissions: ["hub.execute"] }] },
    ],
    [
      "a principal names a host that is not configured",
      {
        ...HTTP,
        principals: [{ email: "niw@niw.at", permissions: ["workspace.read"], hosts: ["server-z"] }],
      },
    ],
  ])("fails when %s", (_label, http) => {
    expect(() => resolve(http)).toThrow(McpGatewayConfigError);
  });

  it("rejects unknown permissions and principals without an identity", () => {
    expect(() =>
      McpGatewayConfigSchema.parse({
        http: { ...HTTP, principals: [{ email: "niw@niw.at", permissions: ["root"] }] },
      }),
    ).toThrow();
    expect(() =>
      McpGatewayConfigSchema.parse({
        http: { ...HTTP, principals: [{ permissions: ["workspace.read"] }] },
      }),
    ).toThrow();
  });
});

describe("MCP gateway config file", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "paseo-mcp-gateway-"));
    configPath = path.join(dir, "mcp-gateway.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a listener without Cloudflare Access readable, so hosts still load", async () => {
    const config = {
      hosts: [{ serverId: "server-a", connection: "127.0.0.1:7777" }],
      http: { listen: "127.0.0.1:6769" },
    };
    await writeFile(configPath, JSON.stringify(config));
    await expect(loadMcpGatewayConfig(configPath)).resolves.toEqual(config);
  });

  it("reads a missing file as an empty gateway", async () => {
    await expect(loadMcpGatewayConfig(configPath)).resolves.toEqual({});
  });

  it("round-trips the config in a file only its owner can read", async () => {
    const config = {
      hosts: [{ serverId: "server-a", label: "work", connection: "127.0.0.1:7777" }],
      http: HTTP,
    };
    await saveMcpGatewayConfig(configPath, McpGatewayConfigSchema.parse(config));
    await expect(loadMcpGatewayConfig(configPath)).resolves.toEqual(config);
    if (process.platform !== "win32") {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(config);
  });

  it("rejects a host listed twice", async () => {
    const host = { serverId: "server-a", connection: "127.0.0.1:7777" };
    await writeFile(configPath, JSON.stringify({ hosts: [host, host] }));
    await expect(loadMcpGatewayConfig(configPath)).rejects.toBeInstanceOf(McpGatewayConfigError);
  });

  it("rejects malformed JSON and unknown keys", async () => {
    await writeFile(configPath, "{");
    await expect(loadMcpGatewayConfig(configPath)).rejects.toBeInstanceOf(McpGatewayConfigError);
    await writeFile(configPath, JSON.stringify({ hosts: [], daemon: {} }));
    await expect(loadMcpGatewayConfig(configPath)).rejects.toBeInstanceOf(McpGatewayConfigError);
  });
});
