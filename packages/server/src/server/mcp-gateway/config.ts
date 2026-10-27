import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DaemonPermissionSchema, type DaemonPermission } from "@getpaseo/protocol/messages";
import { grantsAnyMcpGatewayHostTool } from "./tool-policy.js";

export const MCP_GATEWAY_CONFIG_FILE = "mcp-gateway.json";

const McpGatewayHostSchema = z
  .object({
    serverId: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    connection: z
      .string()
      .trim()
      .min(1)
      .describe("Daemon target: host:port, ws(s) URL, socket, SSH or pairing URL. A credential."),
  })
  .strict();

const principalFields = {
  permissions: z.array(DaemonPermissionSchema),
  hosts: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("Server IDs this principal may reach. Omit for every host."),
};

const McpGatewayPrincipalSchema = z.union([
  z
    .object({
      email: z.string().trim().min(1).describe("Matches the Access JWT email claim."),
      ...principalFields,
    })
    .strict(),
  z
    .object({
      commonName: z
        .string()
        .trim()
        .min(1)
        .describe("Matches the Access JWT common_name claim (service token client ID)."),
      ...principalFields,
    })
    .strict(),
]);

const McpGatewayHttpSchema = z
  .object({
    listen: z.string().trim().min(1).describe("Listener address. Point cloudflared at it."),
    cloudflareAccess: z
      .object({
        teamDomain: z
          .string()
          .trim()
          .min(1)
          .describe("Cloudflare Access team domain, for example example.cloudflareaccess.com."),
        aud: z
          .array(z.string().trim().min(1))
          .min(1)
          .describe("Accepted Access application audience tags."),
      })
      .strict()
      .optional()
      .describe("Required to serve HTTP. The file stays valid without it while you set Access up."),
    principals: z.array(McpGatewayPrincipalSchema).optional(),
  })
  .strict();

export const McpGatewayConfigSchema = z
  .object({
    hosts: z.array(McpGatewayHostSchema).optional(),
    http: McpGatewayHttpSchema.optional(),
  })
  .strict();

export type McpGatewayConfig = z.infer<typeof McpGatewayConfigSchema>;
export type McpGatewayHostEntry = z.infer<typeof McpGatewayHostSchema>;
type PersistedMcpGatewayHttp = z.infer<typeof McpGatewayHttpSchema>;
type PersistedMcpGatewayPrincipal = z.infer<typeof McpGatewayPrincipalSchema>;

export type McpGatewayPrincipalMatch =
  | { kind: "email"; value: string }
  | { kind: "commonName"; value: string };

export interface McpGatewayPrincipal {
  match: McpGatewayPrincipalMatch;
  permissions: readonly DaemonPermission[];
  /** null reaches every configured host. */
  hosts: readonly string[] | null;
}

export interface McpGatewayHttpConfig {
  listen: string;
  cloudflareAccess: {
    issuer: string;
    audiences: readonly string[];
  };
  principals: readonly McpGatewayPrincipal[];
}

export class McpGatewayConfigError extends Error {
  readonly code = "MCP_GATEWAY_CONFIG";
  constructor(message: string) {
    super(`MCP gateway config: ${message}`);
    this.name = "McpGatewayConfigError";
  }
}

export function resolveMcpGatewayConfigPath(paseoHome: string): string {
  return path.join(paseoHome, MCP_GATEWAY_CONFIG_FILE);
}

/** A missing file is an empty gateway: no hosts and no HTTP listener. */
export async function loadMcpGatewayConfig(configPath: string): Promise<McpGatewayConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new McpGatewayConfigError(`${configPath} is not valid JSON`);
  }
  const parsed = McpGatewayConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new McpGatewayConfigError(`${configPath}: ${parsed.error.message}`);
  }
  const seen = new Set<string>();
  for (const host of parsed.data.hosts ?? []) {
    if (seen.has(host.serverId)) {
      throw new McpGatewayConfigError(`host ${host.serverId} is listed more than once`);
    }
    seen.add(host.serverId);
  }
  return parsed.data;
}

/** Connections are credentials, so the file is private to its owner. */
export async function saveMcpGatewayConfig(
  configPath: string,
  config: McpGatewayConfig,
): Promise<void> {
  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(configPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, configPath);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Validates the HTTP section against the configured hosts. A principal that
 * names an unknown host or reaches no host tool is a mistake the user should
 * hear about at startup rather than discover as a silent denial.
 */
export function resolveMcpGatewayHttpConfig(
  http: PersistedMcpGatewayHttp,
  hostIds: ReadonlySet<string>,
): McpGatewayHttpConfig {
  if (!http.cloudflareAccess) {
    throw new McpGatewayConfigError(
      "http.cloudflareAccess is required to serve HTTP. Add teamDomain and aud.",
    );
  }
  return {
    listen: http.listen,
    cloudflareAccess: {
      issuer: resolveAccessIssuer(http.cloudflareAccess.teamDomain),
      audiences: http.cloudflareAccess.aud,
    },
    principals: (http.principals ?? []).map((principal) => resolvePrincipal(principal, hostIds)),
  };
}

function resolvePrincipal(
  principal: PersistedMcpGatewayPrincipal,
  hostIds: ReadonlySet<string>,
): McpGatewayPrincipal {
  const match: McpGatewayPrincipalMatch =
    "email" in principal
      ? { kind: "email", value: principal.email }
      : { kind: "commonName", value: principal.commonName };
  const permissions = [...new Set(principal.permissions)];
  if (!grantsAnyMcpGatewayHostTool(new Set(permissions))) {
    throw new McpGatewayConfigError(
      `principal ${match.value} grants no gateway tools (permissions: ${permissions.join(", ") || "none"})`,
    );
  }
  const hosts = principal.hosts ? [...new Set(principal.hosts)] : null;
  const unknown = hosts?.filter((serverId) => !hostIds.has(serverId)) ?? [];
  if (unknown.length > 0) {
    throw new McpGatewayConfigError(
      `principal ${match.value} names hosts that are not configured: ${unknown.join(", ")}`,
    );
  }
  return { match, permissions, hosts };
}

function resolveAccessIssuer(teamDomain: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(teamDomain) ? teamDomain : `https://${teamDomain}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new McpGatewayConfigError(`invalid cloudflareAccess.teamDomain: ${teamDomain}`);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new McpGatewayConfigError(
      `cloudflareAccess.teamDomain must be a bare host such as example.cloudflareaccess.com: ${teamDomain}`,
    );
  }
  return url.origin;
}
