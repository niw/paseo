import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { DaemonPermission } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { toMcpToolResult } from "../agent/mcp-server.js";
import type { PaseoToolResult } from "../agent/tools/types.js";
import type { McpGatewayHosts } from "./hosts.js";
import {
  isMcpGatewayToolAllowed,
  mcpGatewayToolPolicy,
  type McpGatewayToolEffect,
  type McpGatewayToolName,
} from "./tool-policy.js";

interface McpGatewayToolConfig<Shape extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema: Shape;
}

export type McpGatewayHostToolHandler<Shape extends z.ZodRawShape> = (
  client: DaemonClient,
  args: z.infer<z.ZodObject<Shape>>,
) => Promise<PaseoToolResult>;

/** A tool the caller may use, ready to publish over MCP in either mode. */
export interface McpGatewayTool {
  name: McpGatewayToolName;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  effect: McpGatewayToolEffect;
  /** Runs the tool with arguments already validated against inputSchema. */
  run(args: Record<string, unknown>): Promise<CallToolResult>;
}

/** What a group of gateway tools needs to add itself to one caller's catalog. */
export interface McpGatewayToolRegistry {
  hosts: McpGatewayHosts;
  /** Whether the caller may reach the host. */
  reaches(serverId: string): boolean;
  /** Adds a tool that takes its own input, when the caller may use it. */
  tool<Shape extends z.ZodRawShape>(
    name: McpGatewayToolName,
    config: McpGatewayToolConfig<Shape>,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
  ): void;
  /**
   * Adds a tool that acts on one host. It adds the serverId input, connects,
   * and reports any failure as a tool error naming the host.
   */
  hostTool<Shape extends z.ZodRawShape>(
    name: McpGatewayToolName,
    config: McpGatewayToolConfig<Shape>,
    handler: McpGatewayHostToolHandler<Shape>,
  ): void;
  /** The tools added so far, in the order they were added. */
  tools(): McpGatewayTool[];
}

const serverIdField = z.string().min(1).describe("Destination server ID from list_hosts.");

export function structured(structuredContent: unknown): PaseoToolResult {
  return { content: [], structuredContent };
}

/** Many RPCs report failure in the payload instead of rejecting. */
export function rejectPayloadError<T extends { error: string | null }>(payload: T): T {
  if (payload.error) throw new Error(payload.error);
  return payload;
}

export function createMcpGatewayToolRegistry(input: {
  hosts: McpGatewayHosts;
  /** null is the unrestricted local stdio caller. */
  permissions: ReadonlySet<DaemonPermission> | null;
  /** null reaches every configured host. */
  reachable: ReadonlySet<string> | null;
  /** The tools this session asked for. null is every tool the caller may use. */
  selected: ReadonlySet<McpGatewayToolName> | null;
}): McpGatewayToolRegistry {
  const { hosts, permissions, reachable, selected } = input;
  const catalog: McpGatewayTool[] = [];

  function reaches(serverId: string): boolean {
    return !reachable || reachable.has(serverId);
  }

  function admits(name: McpGatewayToolName): boolean {
    // list_hosts is how a caller learns every other tool's serverId.
    return (
      isMcpGatewayToolAllowed(name, permissions) &&
      (!selected || selected.has(name) || name === "list_hosts")
    );
  }

  async function onHost(
    serverId: string,
    run: (client: DaemonClient) => Promise<PaseoToolResult>,
  ): Promise<CallToolResult> {
    try {
      // A host outside the caller's list reads exactly like an unknown one, so
      // a caller cannot probe which server IDs exist behind the gateway.
      if (!reaches(serverId)) {
        throw new Error(`Unknown host ${serverId}. Call list_hosts for available hosts.`);
      }
      const response = await hosts.use(serverId, run);
      return toMcpToolResult({
        ...response,
        structuredContent: { ...(response.structuredContent as object), serverId },
      });
    } catch (error) {
      const failure = {
        serverId,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && "code" in error ? { code: error.code } : {}),
        ...(error instanceof Error && "outcome" in error ? { outcome: error.outcome } : {}),
      };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(failure) }],
        structuredContent: failure,
      };
    }
  }

  return {
    hosts,
    reaches,
    tool<Shape extends z.ZodRawShape>(
      name: McpGatewayToolName,
      config: McpGatewayToolConfig<Shape>,
      handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
    ) {
      if (!admits(name)) return;
      catalog.push({
        name,
        ...config,
        effect: mcpGatewayToolPolicy(name).effect,
        run: (args) => handler(args as z.infer<z.ZodObject<Shape>>),
      });
    },
    hostTool<Shape extends z.ZodRawShape>(
      name: McpGatewayToolName,
      config: McpGatewayToolConfig<Shape>,
      handler: McpGatewayHostToolHandler<Shape>,
    ) {
      if (!admits(name)) return;
      catalog.push({
        name,
        ...config,
        inputSchema: { serverId: serverIdField, ...config.inputSchema },
        effect: mcpGatewayToolPolicy(name).effect,
        run: (args) => {
          const { serverId, ...rest } = args as { serverId: string };
          return onHost(serverId, (client) =>
            handler(client, rest as unknown as z.infer<z.ZodObject<Shape>>),
          );
        },
      });
    },
    tools: () => [...catalog],
  };
}
