import { randomUUID } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createHostClient } from "@getpaseo/client/node";
import { HostOperationRejectedError } from "../agent/host-operations/index.js";
import type { McpGatewayHostEntry } from "./config.js";

const DEFAULT_CONNECT_WAIT_MS = 15_000;

export interface McpGatewayClientIdentity {
  /**
   * The gateway's own client ID. A daemon resumes the existing session when the
   * same principal connects with the same client ID, so sharing one with the
   * CLI would let each take over the other's session.
   */
  clientId: string;
  appVersion?: string;
}

export interface McpGatewayHostSummary {
  serverId: string;
  label: string;
  status: "idle" | "connecting" | "connected" | "disconnected";
  error?: string;
}

export interface McpGatewayHosts {
  list(): Promise<McpGatewayHostSummary[]>;
  /** Runs the action on a connected client for the host. Failures before it runs reject with HostOperationRejectedError. */
  use<T>(serverId: string, action: (client: DaemonClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * One long-lived client per configured host, opened on first use. The gateway
 * is an ordinary client of each daemon: the daemon authorizes it as whatever
 * principal the saved connection authenticates as.
 */
export function createMcpGatewayHosts(input: {
  hosts: readonly McpGatewayHostEntry[];
  identity: McpGatewayClientIdentity;
  /**
   * Reads the saved hosts again. `paseo mcp host add` runs in another process,
   * so the gateway rereads when a caller lists hosts or names a server ID it
   * does not know, rather than watching the file.
   */
  reload?: () => Promise<readonly McpGatewayHostEntry[]>;
  /** Called when reload fails; the hosts in effect stay as they were. */
  onReloadError?: (error: unknown) => void;
  /** How long a tool call waits for a host that is still connecting. */
  connectWaitMs?: number;
}): McpGatewayHosts {
  let entries = new Map(input.hosts.map((host) => [host.serverId, host]));
  const clients = new Map<string, DaemonClient>();
  const connectWaitMs = input.connectWaitMs ?? DEFAULT_CONNECT_WAIT_MS;
  let reloading: Promise<void> | null = null;

  function dropClient(serverId: string): void {
    const client = clients.get(serverId);
    if (!client) return;
    clients.delete(serverId);
    void client.close();
  }

  async function reread(read: () => Promise<readonly McpGatewayHostEntry[]>): Promise<void> {
    try {
      const nextEntries = new Map((await read()).map((host) => [host.serverId, host]));
      for (const [serverId, entry] of entries) {
        if (nextEntries.get(serverId)?.connection !== entry.connection) dropClient(serverId);
      }
      entries = nextEntries;
    } catch (error) {
      input.onReloadError?.(error);
    }
  }

  /** Concurrent callers share one reread. */
  function reload(): Promise<void> {
    if (!input.reload) return Promise.resolve();
    reloading ??= reread(input.reload).finally(() => {
      reloading = null;
    });
    return reloading;
  }

  function clientFor(entry: McpGatewayHostEntry): DaemonClient {
    let client = clients.get(entry.serverId);
    if (!client) {
      // Reconnect stays on: once a host has been used, the client keeps
      // retrying in the background so the next call finds it connected.
      client = createHostClient(entry.connection, {
        clientId: input.identity.clientId,
        clientType: "mcp",
        appVersion: input.identity.appVersion,
      });
      clients.set(entry.serverId, client);
    }
    return client;
  }

  async function connected(entry: McpGatewayHostEntry): Promise<DaemonClient> {
    const client = clientFor(entry);
    if (!client.isConnected) {
      await waitFor(client.connect(), connectWaitMs, `Host ${entry.serverId} is not reachable`);
    }
    const actual = client.getLastServerInfoMessage()?.serverId;
    if (actual !== entry.serverId) {
      clients.delete(entry.serverId);
      await client.close();
      throw new Error(
        `Host ${entry.serverId} answered as ${actual ?? "an unknown server"}. Remove it and add it again.`,
      );
    }
    return client;
  }

  return {
    async list() {
      await reload();
      return [...entries.values()].map((entry) => {
        const state = clients.get(entry.serverId)?.getConnectionState() ?? { status: "idle" };
        const summary: McpGatewayHostSummary = {
          serverId: entry.serverId,
          label: entry.label ?? entry.serverId,
          status: state.status === "disposed" ? "disconnected" : state.status,
        };
        if (state.status === "disconnected" && state.reason) summary.error = state.reason;
        return summary;
      });
    },
    async use(serverId, action) {
      if (!entries.has(serverId)) await reload();
      const entry = entries.get(serverId);
      if (!entry) {
        throw new HostOperationRejectedError(
          new Error(`Unknown host ${serverId}. Call list_hosts for available hosts.`),
        );
      }
      let client: DaemonClient;
      try {
        client = await connected(entry);
      } catch (error) {
        throw new HostOperationRejectedError(error);
      }
      return action(client);
    },
    async close() {
      const open = [...clients.values()];
      clients.clear();
      await Promise.all(open.map((client) => client.close()));
    },
  };
}

/**
 * Connects once to learn the server ID a connection answers as. It uses a
 * throwaway client ID so it cannot take over a running gateway's session.
 */
export async function identifyMcpGatewayHost(input: {
  connection: string;
  appVersion?: string;
  connectTimeoutMs?: number;
}): Promise<string> {
  const client = createHostClient(input.connection, {
    clientId: `cid_${randomUUID().replace(/-/g, "")}`,
    clientType: "mcp",
    appVersion: input.appVersion,
    connectTimeoutMs: input.connectTimeoutMs ?? DEFAULT_CONNECT_WAIT_MS,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    const serverId = client.getLastServerInfoMessage()?.serverId;
    if (!serverId) throw new Error("The host did not report a server ID");
    return serverId;
  } finally {
    await client.close();
  }
}

async function waitFor<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
