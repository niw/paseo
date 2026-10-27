import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toMcpToolResult } from "../agent/mcp-server.js";
import { structured, type McpGatewayTool } from "./tool-registry.js";

export const MCP_GATEWAY_EXEC_TOOL = "paseo";

const execInputSchema = {
  command: z
    .enum(["tools", "search", "info", "call"])
    .describe(
      "tools: list every tool. search: find tools. info: read a tool's input schema. call: run a tool.",
    ),
  query: z.string().optional().describe("Words to search tool names, titles and descriptions for."),
  tool: z.string().optional().describe("Tool name for info and call."),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arguments for call, matching the tool's input schema from info."),
  confirm: z
    .boolean()
    .optional()
    .describe("Set true to call a destructive tool, once the user has agreed to it."),
};

type ExecInput = z.infer<z.ZodObject<typeof execInputSchema>>;

const EXEC_DESCRIPTION = [
  "Drive coding agents and their workspaces on Paseo hosts. One command per call:",
  "- tools: list every tool with its title.",
  "- search with query: find tools by name, title or description.",
  "- info with tool: a tool's description and JSON input schema.",
  "- call with tool and args: run it. Destructive tools also need confirm: true.",
  "Start with call list_hosts; every other tool takes a serverId from it.",
].join("\n");

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function summary(tool: McpGatewayTool) {
  return { name: tool.name, title: tool.title, effect: tool.effect };
}

/**
 * Serves the catalog through one tool, so a session's context holds one tool
 * definition however many tools there are. The model discovers tools with
 * search and info and runs them with call; the same policy decides which
 * tools exist, and destructive ones need an explicit confirm.
 */
export function registerMcpGatewayExecTool(server: McpServer, catalog: McpGatewayTool[]): void {
  const byName = new Map(catalog.map((tool) => [tool.name as string, tool]));

  function find(
    name: string | undefined,
  ): { tool: McpGatewayTool; error?: never } | { tool?: never; error: CallToolResult } {
    if (!name) return { error: failure("Pass the tool name in tool.") };
    const tool = byName.get(name);
    return tool
      ? { tool }
      : { error: failure(`Unknown tool ${name}. Use search or tools to find one.`) };
  }

  async function execute(input: ExecInput): Promise<CallToolResult> {
    switch (input.command) {
      case "tools":
        return toMcpToolResult(structured({ tools: catalog.map(summary) }));
      case "search": {
        const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 0) return failure("Pass the words to search for in query.");
        const matches = catalog.filter((tool) => {
          const text = `${tool.name} ${tool.title} ${tool.description}`.toLowerCase();
          return words.every((word) => text.includes(word));
        });
        return toMcpToolResult(structured({ tools: matches.map(summary) }));
      }
      case "info": {
        const { tool, error } = find(input.tool);
        if (error) return error;
        return toMcpToolResult(
          structured({
            ...summary(tool),
            description: tool.description,
            inputSchema: z.toJSONSchema(z.object(tool.inputSchema)),
          }),
        );
      }
      case "call": {
        const { tool, error } = find(input.tool);
        if (error) return error;
        const parsed = z.object(tool.inputSchema).safeParse(input.args ?? {});
        if (!parsed.success) {
          return failure(
            `Invalid args for ${tool.name}:\n${z.prettifyError(parsed.error)}\nUse info for its input schema.`,
          );
        }
        if (tool.effect === "destructive" && input.confirm !== true) {
          return failure(
            `${tool.name} is destructive: ${tool.description} Call again with confirm: true once the user has agreed.`,
          );
        }
        return tool.run(parsed.data);
      }
    }
  }

  server.registerTool(
    MCP_GATEWAY_EXEC_TOOL,
    {
      title: "Paseo",
      description: EXEC_DESCRIPTION,
      inputSchema: execInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    execute as ToolCallback<typeof execInputSchema>,
  );
}
