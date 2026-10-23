import { describe, expect, it } from "vitest";

import { PersistedConfigSchema } from "../persisted-config.js";
import { ExternalMcpConfigError, resolveExternalMcpConfig } from "./config.js";

function resolve(external: unknown) {
  const persisted = PersistedConfigSchema.parse({ daemon: { mcp: { external } } });
  return resolveExternalMcpConfig(persisted.daemon);
}

const ENABLED = {
  enabled: true,
  listen: "127.0.0.1:6768",
  cloudflareAccess: { teamDomain: "example.cloudflareaccess.com", aud: ["aud-1"] },
  principals: [{ email: "niw@niw.at", permissions: ["workspace.read", "workspace.write"] }],
};

describe("external MCP config", () => {
  it("is off unless enabled", () => {
    expect(resolveExternalMcpConfig(undefined)).toBeNull();
    expect(resolve({ ...ENABLED, enabled: false })).toBeNull();
    expect(resolve({ listen: "127.0.0.1:6768" })).toBeNull();
  });

  it("resolves an enabled listener", () => {
    expect(resolve(ENABLED)).toEqual({
      listen: "127.0.0.1:6768",
      cloudflareAccess: { issuer: "https://example.cloudflareaccess.com", audiences: ["aud-1"] },
      principals: [
        {
          match: { kind: "email", value: "niw@niw.at" },
          permissions: ["workspace.read", "workspace.write"],
        },
      ],
    });
  });

  it("accepts a team domain written as a URL", () => {
    const resolved = resolve({
      ...ENABLED,
      cloudflareAccess: { teamDomain: "https://example.cloudflareaccess.com/", aud: ["aud-1"] },
    });
    expect(resolved?.cloudflareAccess.issuer).toBe("https://example.cloudflareaccess.com");
  });

  it.each([
    ["listen is missing", { ...ENABLED, listen: undefined }],
    ["cloudflareAccess is missing", { ...ENABLED, cloudflareAccess: undefined }],
    [
      "the team domain has a path",
      {
        ...ENABLED,
        cloudflareAccess: { teamDomain: "example.cloudflareaccess.com/certs", aud: ["aud-1"] },
      },
    ],
    [
      "the team domain is not https",
      {
        ...ENABLED,
        cloudflareAccess: { teamDomain: "http://example.cloudflareaccess.com", aud: ["aud-1"] },
      },
    ],
    [
      "a principal reaches no tool",
      { ...ENABLED, principals: [{ commonName: "client.access", permissions: ["hub.execute"] }] },
    ],
  ])("fails startup when %s", (_label, external) => {
    expect(() => resolve(external)).toThrow(ExternalMcpConfigError);
  });

  it("rejects unknown permissions and principals without an identity", () => {
    expect(() =>
      resolve({ ...ENABLED, principals: [{ email: "niw@niw.at", permissions: ["root"] }] }),
    ).toThrow();
    expect(() =>
      resolve({ ...ENABLED, principals: [{ permissions: ["workspace.read"] }] }),
    ).toThrow();
  });
});
