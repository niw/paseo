import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  McpGatewayInstanceError,
  readMcpGatewayInstance,
  startMcpGatewayInstance,
  stopMcpGatewayInstance,
} from "./instance.js";

const fixture = fileURLToPath(new URL("./test-fixtures/serve-http.ts", import.meta.url));

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paseo-mcp-gateway-instance-"));
});

afterEach(async () => {
  await stopMcpGatewayInstance(home, { force: true }).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

async function writeConfig(http: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(home, "mcp-gateway.json"), JSON.stringify({ hosts: [], http }));
}

function start() {
  return startMcpGatewayInstance({
    home,
    command: process.execPath,
    args: ["--import", "tsx", fixture, home],
    env: process.env,
    timeoutMs: 30_000,
  });
}

describe("background MCP gateway", () => {
  it("starts once per home, reports where it listens, and stops", async () => {
    await writeConfig({
      listen: "127.0.0.1:0",
      cloudflareAccess: { teamDomain: "example.cloudflareaccess.com", aud: ["aud-1"] },
    });
    const first = await start();
    expect(first.spawned).toBe(true);
    expect(first.instance.listen).toMatch(/^127\.0\.0\.1:\d+$/);
    const response = await fetch(`http://${first.instance.listen}/mcp/agents`, { method: "POST" });
    expect(response.status).toBe(401);
    // A background gateway has no terminal; it writes its own log.
    const log = await readFile(path.join(home, "mcp-gateway.log"), "utf8");
    expect(log).toContain('"msg":"MCP gateway listening"');

    const second = await start();
    expect(second).toEqual({ instance: first.instance, spawned: false });
    await expect(readMcpGatewayInstance(home)).resolves.toEqual(first.instance);

    await expect(stopMcpGatewayInstance(home)).resolves.toEqual({
      action: "stopped",
      pid: first.instance.pid,
      forced: false,
    });
    await expect(readMcpGatewayInstance(home)).resolves.toBeNull();
    expect(existsSync(path.join(home, "mcp-gateway.pid"))).toBe(false);
    await expect(stopMcpGatewayInstance(home)).resolves.toMatchObject({ action: "not_running" });
  }, 60_000);

  it("reports why a gateway failed to start", async () => {
    await writeConfig({ listen: "127.0.0.1:0" });
    const failure = await start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpGatewayInstanceError);
    expect((failure as McpGatewayInstanceError).code).toBe("MCP_GATEWAY_START_FAILED");
    expect((failure as Error).message).toContain("http.cloudflareAccess is required");
    await expect(readMcpGatewayInstance(home)).resolves.toBeNull();
  }, 60_000);
});
