import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CloudflareAccessTokenError,
  createCloudflareAccessVerifier,
  resolveExternalPrincipal,
  type CloudflareAccessVerifier,
} from "./cloudflare-access.js";

const ISSUER = "https://example.cloudflareaccess.com";
const AUDIENCE = "aud-tag-1";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let accessKey: KeyPair;
let otherKey: KeyPair;
let verifier: CloudflareAccessVerifier;

beforeAll(async () => {
  accessKey = await generateKeyPair("RS256", { extractable: true });
  otherKey = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(accessKey.publicKey)), kid: "access-1", alg: "RS256" };
  verifier = createCloudflareAccessVerifier({
    issuer: ISSUER,
    audiences: [AUDIENCE],
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
});

function sign(
  payload: JWTPayload,
  options: { key?: KeyPair; issuer?: string; audience?: string; expiresAt?: number } = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "access-1" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? "5m")
    .sign((options.key ?? accessKey).privateKey);
}

describe("Cloudflare Access JWT verification", () => {
  it("returns the user and service identities from a valid token", async () => {
    await expect(verifier.verify(await sign({ email: "user@example.com" }))).resolves.toEqual({
      email: "user@example.com",
    });
    await expect(
      verifier.verify(await sign({ common_name: "client.access", sub: "" })),
    ).resolves.toEqual({ commonName: "client.access" });
  });

  it.each([
    ["another audience", { audience: "aud-other" }],
    ["another issuer", { issuer: "https://attacker.cloudflareaccess.com" }],
    ["an expired token", { expiresAt: Math.floor(Date.now() / 1000) - 120 }],
  ])("rejects %s", async (_label, options) => {
    const token = await sign({ email: "user@example.com" }, options);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(CloudflareAccessTokenError);
  });

  it("rejects a token with the right claims signed by another key", async () => {
    const token = await sign({ email: "user@example.com" }, { key: otherKey });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(CloudflareAccessTokenError);
  });

  it("rejects an unsigned token", async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const token = `${encode({ alg: "none" })}.${encode({
      iss: ISSUER,
      aud: AUDIENCE,
      email: "user@example.com",
      exp: now + 300,
    })}.`;
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(CloudflareAccessTokenError);
  });

  it("rejects a token signed with HS256 using the public key as the secret", async () => {
    const secret = new TextEncoder().encode(JSON.stringify(await exportJWK(accessKey.publicKey)));
    const token = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "HS256", kid: "access-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(secret);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(CloudflareAccessTokenError);
  });
});

describe("external principal resolution", () => {
  const principals = [
    { match: { kind: "email", value: "User@Example.com" }, permissions: ["workspace.read"] },
    { match: { kind: "commonName", value: "client.access" }, permissions: ["workspace.write"] },
  ] as const;

  it("matches email without regard to case", () => {
    expect(resolveExternalPrincipal({ email: "user@EXAMPLE.com" }, principals)).toEqual({
      principalId: "cf-access:email:user@example.com",
      permissions: ["workspace.read"],
    });
  });

  it("matches a service token by common name", () => {
    expect(resolveExternalPrincipal({ commonName: "client.access" }, principals)).toEqual({
      principalId: "cf-access:service:client.access",
      permissions: ["workspace.write"],
    });
  });

  it("returns null for an identity nobody listed", () => {
    expect(resolveExternalPrincipal({ email: "someone@example.com" }, principals)).toBeNull();
    expect(resolveExternalPrincipal({}, principals)).toBeNull();
  });
});
