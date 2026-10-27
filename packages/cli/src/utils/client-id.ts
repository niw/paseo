import { ensurePrivateDirectory } from "@getpaseo/server/daemon-control";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

function normalizeClientId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function generateClientId(): string {
  return `cid_${randomUUID().replace(/-/g, "")}`;
}

export function getOrCreateCliClientId(home: string): Promise<string> {
  return getOrCreateClientId(home, "cli-client-id");
}

/** Kept apart from the CLI's ID: a daemon resumes the session of a repeated client ID. */
export function getOrCreateMcpGatewayClientId(home: string): Promise<string> {
  return getOrCreateClientId(home, "mcp-gateway-client-id");
}

async function getOrCreateClientId(home: string, fileName: string): Promise<string> {
  const clientSessionKeyFile = join(home, fileName);

  try {
    const existing = normalizeClientId(await readFile(clientSessionKeyFile, "utf8"));
    if (existing) {
      return existing;
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const nextValue = generateClientId();
  ensurePrivateDirectory(home);
  await writeFile(clientSessionKeyFile, nextValue, { mode: 0o600 });
  return nextValue;
}
