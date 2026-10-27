import {
  ActiveTurnBehaviorSchema,
  AgentPermissionResponseSchema,
  type AgentSnapshotPayload,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { createRemoteHostOperations } from "../agent/host-operations/index.js";
import {
  AgentStatusEnum,
  resolveRequiredProviderModel,
  sanitizePermissionRequest,
} from "../agent/mcp-shared.js";
import { structured, type McpGatewayToolRegistry } from "./tool-registry.js";

const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 600;
const PERMISSION_RESPONSE_TIMEOUT_MS = 15_000;

const ProviderModelSchema = z
  .string()
  .trim()
  .refine(
    (value) => {
      try {
        resolveRequiredProviderModel(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "provider must be provider/model, for example codex/gpt-5.4" },
  )
  .describe("Required provider/model pair, for example codex/gpt-5.4. See list_models.");

/** Creating, prompting, observing and controlling agents on a host. */
export function registerAgentTools(registry: McpGatewayToolRegistry): void {
  registry.hostTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        "Create an agent in an existing workspace on a host. Requires provider/model and an initial prompt. Use list_workspaces to find the workspace and list_models for the model.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Existing workspace id on the host."),
        provider: ProviderModelSchema,
        title: z
          .string()
          .trim()
          .min(1, "Title is required")
          .max(60, "Title must be 60 characters or fewer")
          .describe("Short descriptive title (<= 60 chars) summarizing the agent's focus."),
        initialPrompt: z
          .string()
          .trim()
          .min(1, "initialPrompt is required")
          .describe("Required first task to run immediately after creation."),
        labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
        settings: z
          .object({
            modeId: z
              .string()
              .optional()
              .describe("Session mode to configure before the first run."),
            thinkingOptionId: z.string().optional().describe("Thinking option ID."),
            features: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("Provider-specific feature values."),
          })
          .strict()
          .optional()
          .describe("Initial runtime settings for the new agent."),
      },
    },
    (client, args) => createRemoteHostOperations(client, null).createAgent(args, {}),
  );

  registry.hostTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description:
        "Send a prompt to an agent on a host. Use wait_for_agent to wait for it to finish.",
      inputSchema: {
        agentId: z.string(),
        prompt: z.string(),
        sessionMode: z
          .string()
          .optional()
          .describe("Optional mode to set before running the prompt."),
        activeTurnBehavior: ActiveTurnBehaviorSchema.optional().describe(
          'How to send into a running turn: "steer" joins it, falling back to interrupt when unavailable; "interrupt" replaces it. Defaults to interrupt.',
        ),
      },
    },
    (client, args) => createRemoteHostOperations(client, null).sendPrompt(args, {}),
  );

  registry.hostTool(
    "get_agent_status",
    {
      title: "Get agent status",
      description:
        "Return the latest snapshot for an agent, including lifecycle state and pending permissions.",
      inputSchema: { agentId: z.string() },
    },
    (client, args) => createRemoteHostOperations(client, null).getStatus(args, {}),
  );

  registry.hostTool(
    "get_agent_activity",
    {
      title: "Get agent activity",
      description: "Return recent agent timeline entries as a curated summary.",
      inputSchema: {
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for number of activities to include (most recent first)."),
      },
    },
    (client, args) => createRemoteHostOperations(client, null).getActivity(args, {}),
  );

  registry.hostTool(
    "list_agents",
    {
      title: "List agents",
      description: "List recent agents on a host as compact metadata.",
      inputSchema: {
        includeBackground: z.boolean().optional().default(false),
        includeArchived: z.boolean().optional().default(false),
        cwd: z.string().optional().describe("Absolute directory on the host to filter by."),
        sinceHours: z
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .optional()
          .default(48),
        statuses: z.array(AgentStatusEnum).optional(),
        limit: z.number().int().positive().max(200).optional().default(50),
      },
    },
    (client, args) => createRemoteHostOperations(client, null).listAgents(args, {}),
  );

  registry.hostTool(
    "wait_for_agent",
    {
      title: "Wait for agent",
      description: `Wait until an agent on a host finishes its turn, fails, or needs permission. Returns status "timeout" if it is still running after timeoutSeconds; call again to keep waiting.`,
      inputSchema: {
        agentId: z.string(),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .max(MAX_WAIT_SECONDS)
          .optional()
          .default(DEFAULT_WAIT_SECONDS),
      },
    },
    async (client, { agentId, timeoutSeconds }) => {
      const outcome = await client.waitForFinish(agentId, timeoutSeconds * 1000);
      if (!outcome.final && outcome.error) throw new Error(outcome.error);
      return structured({
        agentId,
        status: outcome.status,
        agentStatus: outcome.final?.status ?? null,
        lastMessage: outcome.lastMessage,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    },
  );

  registry.hostTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent's name, labels, and/or runtime settings.",
      inputSchema: {
        agentId: z.string(),
        name: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
        settings: z
          .object({
            modeId: z.string().optional().describe("Session mode ID."),
            model: z.string().nullable().optional().describe("Model ID. Pass null to clear."),
            thinkingOptionId: z
              .string()
              .nullable()
              .optional()
              .describe("Thinking option ID. Pass null to clear."),
            features: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("Provider-specific feature values."),
          })
          .strict()
          .optional()
          .describe("Runtime settings to apply to the agent."),
      },
    },
    async (client, { agentId, name, labels, settings }) => {
      if (settings?.modeId !== undefined) await client.setAgentMode(agentId, settings.modeId);
      if (settings?.model !== undefined) await client.setAgentModel(agentId, settings.model);
      if (settings?.thinkingOptionId !== undefined) {
        await client.setAgentThinkingOption(agentId, settings.thinkingOptionId);
      }
      for (const [featureId, value] of Object.entries(settings?.features ?? {})) {
        await client.setAgentFeature(agentId, featureId, value);
      }
      if (name !== undefined || labels !== undefined) {
        await client.updateAgent(agentId, { name, labels });
      }
      return structured({ success: true });
    },
  );

  registry.hostTool(
    "set_agent_mode",
    {
      title: "Set agent mode",
      description:
        "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
      inputSchema: { agentId: z.string(), modeId: z.string() },
    },
    async (client, { agentId, modeId }) => {
      await client.setAgentMode(agentId, modeId);
      return structured({ success: true, newMode: modeId });
    },
  );

  registry.hostTool(
    "cancel_agent",
    {
      title: "Cancel agent run",
      description: "Abort the agent's current run but keep the agent alive for future tasks.",
      inputSchema: { agentId: z.string() },
    },
    async (client, { agentId }) => {
      await client.cancelAgent(agentId);
      return structured({ success: true });
    },
  );

  registry.hostTool(
    "archive_agent",
    {
      title: "Archive agent",
      description:
        "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list.",
      inputSchema: { agentId: z.string() },
    },
    async (client, { agentId }) => {
      const { archivedAt } = await client.archiveAgent(agentId);
      return structured({ success: true, archivedAt });
    },
  );

  registry.hostTool(
    "list_pending_permissions",
    {
      title: "List pending permissions",
      description: "Return pending permission requests across the agents on a host.",
      inputSchema: {},
    },
    async (client) => {
      const agents: AgentSnapshotPayload[] = [];
      let cursor: string | undefined;
      do {
        const { entries, pageInfo } = await client.fetchAgents({
          includeBackground: true,
          // Creation time keeps agents from moving between pages as they update.
          sort: [{ key: "created_at", direction: "desc" }],
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        agents.push(...entries.map(({ agent }) => agent));
        cursor = pageInfo.nextCursor ?? undefined;
      } while (cursor);
      const permissions = agents.flatMap((agent) =>
        agent.pendingPermissions.map((request) => ({
          agentId: agent.id,
          status: agent.status,
          request: sanitizePermissionRequest(request),
        })),
      );
      return structured({ permissions });
    },
  );

  registry.hostTool(
    "respond_to_permission",
    {
      title: "Respond to permission",
      description:
        "Approve or deny a pending permission request. Use list_pending_permissions for the requestId and the actions it offers.",
      inputSchema: {
        agentId: z.string(),
        requestId: z.string(),
        response: AgentPermissionResponseSchema,
      },
    },
    async (client, { agentId, requestId, response }) => {
      await client.respondToPermissionAndWait(
        agentId,
        requestId,
        response,
        PERMISSION_RESPONSE_TIMEOUT_MS,
      );
      return structured({ success: true });
    },
  );
}
