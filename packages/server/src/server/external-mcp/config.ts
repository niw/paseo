import type { DaemonPermission } from "@getpaseo/protocol/messages";
import type { PersistedConfig, PersistedExternalMcpPrincipal } from "../persisted-config.js";
import { grantsAnyExternalTool } from "./tool-permissions.js";

export type ExternalMcpPrincipalMatch =
  | { kind: "email"; value: string }
  | { kind: "commonName"; value: string };

export interface ExternalMcpPrincipal {
  match: ExternalMcpPrincipalMatch;
  permissions: readonly DaemonPermission[];
}

export interface ExternalMcpConfig {
  listen: string;
  cloudflareAccess: {
    issuer: string;
    audiences: readonly string[];
  };
  principals: readonly ExternalMcpPrincipal[];
}

export class ExternalMcpConfigError extends Error {
  constructor(message: string) {
    super(`daemon.mcp.external: ${message}`);
    this.name = "ExternalMcpConfigError";
  }
}

/**
 * Returns null unless the external listener is explicitly enabled. An enabled
 * listener with missing settings is a startup error, not a silent no-op: the
 * user asked for a public surface and should learn immediately that it is not
 * serving.
 */
export function resolveExternalMcpConfig(
  persisted: PersistedConfig["daemon"],
): ExternalMcpConfig | null {
  const external = persisted?.mcp?.external;
  if (external?.enabled !== true) {
    return null;
  }
  const listen = external.listen?.trim();
  if (!listen) {
    throw new ExternalMcpConfigError("listen is required when enabled");
  }
  if (!external.cloudflareAccess) {
    throw new ExternalMcpConfigError("cloudflareAccess is required when enabled");
  }

  return {
    listen,
    cloudflareAccess: {
      issuer: resolveAccessIssuer(external.cloudflareAccess.teamDomain),
      audiences: external.cloudflareAccess.aud,
    },
    principals: (external.principals ?? []).map(resolvePrincipal),
  };
}

function resolvePrincipal(principal: PersistedExternalMcpPrincipal): ExternalMcpPrincipal {
  const match: ExternalMcpPrincipalMatch =
    "email" in principal
      ? { kind: "email", value: principal.email }
      : { kind: "commonName", value: principal.commonName };
  const permissions = [...new Set(principal.permissions)];
  // The MCP server only answers tools/list once a tool is registered, so a
  // principal that reaches no tool would see "Method not found" rather than an
  // empty list. Treat it as the configuration mistake it is.
  if (!grantsAnyExternalTool(new Set(permissions))) {
    throw new ExternalMcpConfigError(
      `principal ${match.value} grants no external MCP tools (permissions: ${permissions.join(", ") || "none"})`,
    );
  }
  return { match, permissions };
}

function resolveAccessIssuer(teamDomain: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(teamDomain) ? teamDomain : `https://${teamDomain}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ExternalMcpConfigError(`invalid cloudflareAccess.teamDomain: ${teamDomain}`);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new ExternalMcpConfigError(
      `cloudflareAccess.teamDomain must be a bare host such as example.cloudflareaccess.com: ${teamDomain}`,
    );
  }
  return url.origin;
}
