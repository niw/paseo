import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { DaemonPermission } from "@getpaseo/protocol/messages";
import type { ExternalMcpPrincipal } from "./config.js";

/** Header Cloudflare Access adds to every request it lets through to the origin. */
export const CLOUDFLARE_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

// Access signs with RS256. Pinning the algorithm keeps `none` and HMAC tokens
// (signed with the public key as a shared secret) from ever verifying.
const ACCESS_JWT_ALGORITHMS = ["RS256"];
const ACCESS_JWT_CLOCK_TOLERANCE_SECONDS = 30;

export interface CloudflareAccessIdentity {
  /** Present for tokens issued to a user. */
  email?: string;
  /** Present for tokens issued to a service token; the token's client ID. */
  commonName?: string;
}

export interface CloudflareAccessVerifier {
  verify(token: string): Promise<CloudflareAccessIdentity>;
}

export class CloudflareAccessTokenError extends Error {
  constructor(options: { cause: unknown }) {
    const reason = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`Invalid Cloudflare Access token: ${reason}`, options);
    this.name = "CloudflareAccessTokenError";
  }
}

/**
 * Verifies the JWT Cloudflare Access attaches after it has authenticated the
 * caller. Signature, issuer, audience and expiry are all checked; the issuer and
 * audience alone are public and prove nothing.
 */
export function createCloudflareAccessVerifier(options: {
  issuer: string;
  audiences: readonly string[];
  /** Signing keys. Defaults to the team's published certs, cached and refreshed on unknown kid. */
  keys?: JWTVerifyGetKey;
}): CloudflareAccessVerifier {
  const keys = options.keys ?? createRemoteJWKSet(new URL("/cdn-cgi/access/certs", options.issuer));
  const audience = [...options.audiences];
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: options.issuer,
          audience,
          algorithms: ACCESS_JWT_ALGORITHMS,
          clockTolerance: ACCESS_JWT_CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ["exp"],
        });
        return {
          ...(typeof payload.email === "string" && payload.email ? { email: payload.email } : {}),
          ...(typeof payload.common_name === "string" && payload.common_name
            ? { commonName: payload.common_name }
            : {}),
        };
      } catch (error) {
        throw new CloudflareAccessTokenError({ cause: error });
      }
    },
  };
}

export interface ResolvedExternalPrincipal {
  principalId: string;
  permissions: readonly DaemonPermission[];
}

/**
 * Maps a verified identity to the configured principal. Access decides who may
 * reach the daemon; this decides what they may do. An identity nobody listed
 * gets nothing, even though Access let it through.
 */
export function resolveExternalPrincipal(
  identity: CloudflareAccessIdentity,
  principals: readonly ExternalMcpPrincipal[],
): ResolvedExternalPrincipal | null {
  const email = identity.email?.toLowerCase();
  for (const principal of principals) {
    const { match } = principal;
    if (match.kind === "email" && email !== undefined && match.value.toLowerCase() === email) {
      return { principalId: `cf-access:email:${email}`, permissions: principal.permissions };
    }
    if (match.kind === "commonName" && match.value === identity.commonName) {
      return {
        principalId: `cf-access:service:${identity.commonName}`,
        permissions: principal.permissions,
      };
    }
  }
  return null;
}
