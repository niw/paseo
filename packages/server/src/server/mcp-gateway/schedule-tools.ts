import type {
  CreateScheduleOptions,
  UpdateScheduleOptions,
} from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { parseDurationString } from "../agent/mcp-shared.js";
import { rejectPayloadError, structured, type McpGatewayToolRegistry } from "./tool-registry.js";

const DurationSchema = z
  .string()
  .trim()
  .superRefine((value, context) => {
    try {
      parseDurationString(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const scheduleIdField = z.string().min(1).describe("Schedule ID from list_schedules.");

function expiresAtFrom(expiresIn: string | undefined): string | undefined {
  return expiresIn === undefined
    ? undefined
    : new Date(Date.now() + parseDurationString(expiresIn)).toISOString();
}

/** Splits provider or provider/model. */
function splitProvider(value: string): { provider: string; model?: string } {
  const slash = value.indexOf("/");
  if (slash === -1) return { provider: value };
  const provider = value.slice(0, slash).trim();
  const model = value.slice(slash + 1).trim();
  if (!provider || !model) throw new Error("provider must be <provider> or <provider>/<model>");
  return { provider, model };
}

function cadenceFrom(cron: string, timezone: string | undefined): CreateScheduleOptions["cadence"] {
  return { type: "cron", expression: cron, ...(timezone ? { timezone } : {}) };
}

type NewAgentPatch = NonNullable<UpdateScheduleOptions["newAgentConfig"]>;

function newAgentPatchFrom(input: {
  provider?: string;
  model?: string | null;
  mode?: string | null;
  cwd?: string;
}): NewAgentPatch | undefined {
  const fromProvider: { provider?: string; model?: string } = input.provider
    ? splitProvider(input.provider)
    : {};
  if (fromProvider.model && input.model !== undefined && input.model !== fromProvider.model) {
    throw new Error("Conflicting model values provided");
  }
  const model = input.model !== undefined ? input.model : fromProvider.model;
  const patch: NewAgentPatch = {
    ...(fromProvider.provider ? { provider: fromProvider.provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(input.mode !== undefined ? { modeId: input.mode } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Recurring prompts on a host, delivered to a new agent per run or to an existing agent. */
export function registerScheduleTools(registry: McpGatewayToolRegistry): void {
  registry.hostTool(
    "create_schedule",
    {
      title: "Create schedule",
      description:
        "Create a recurring schedule on a host. Each run either starts a new agent (provider and cwd) or prompts an existing agent (agentId).",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        cron: z.string().trim().min(1, "cron is required"),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for the cron cadence. For example: America/New_York."),
        name: z.string().optional(),
        agentId: z.string().min(1).optional().describe("Existing agent to prompt on each run."),
        provider: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Provider or provider/model for a new agent per run, for example codex/gpt-5.4.",
          ),
        cwd: z
          .string()
          .optional()
          .describe("Absolute working directory on the host for a new agent per run."),
        mode: z.string().optional().describe("Session mode for a new agent per run."),
        thinkingOptionId: z
          .string()
          .optional()
          .describe("Thinking option for a new agent per run."),
        isolation: z.enum(["local", "worktree"]).optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: DurationSchema.optional().describe("Relative expiry, for example 30m or 12h."),
        runNow: z.boolean().optional().describe("Run once immediately as well."),
      },
    },
    async (client, input) => {
      let target: CreateScheduleOptions["target"];
      if (input.agentId !== undefined) {
        if (input.provider !== undefined || input.cwd !== undefined) {
          throw new Error("Pass either agentId or provider and cwd, not both");
        }
        target = { type: "agent", agentId: input.agentId };
      } else {
        if (!input.provider || !input.cwd) {
          throw new Error("A new-agent schedule needs provider and cwd; or pass agentId");
        }
        target = {
          type: "new-agent",
          config: {
            ...splitProvider(input.provider),
            cwd: input.cwd,
            ...(input.mode ? { modeId: input.mode } : {}),
            ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
            ...(input.isolation ? { isolation: input.isolation } : {}),
          },
        };
      }
      const expiresAt = expiresAtFrom(input.expiresIn);
      const { schedule } = rejectPayloadError(
        await client.scheduleCreate({
          prompt: input.prompt,
          cadence: cadenceFrom(input.cron, input.timezone),
          target,
          ...(input.name?.trim() ? { name: input.name.trim() } : {}),
          ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(input.runNow !== undefined ? { runOnCreate: input.runNow } : {}),
        }),
      );
      return structured(schedule);
    },
  );

  registry.hostTool(
    "update_schedule",
    {
      title: "Update schedule",
      description:
        "Update an existing schedule. Only provided fields are changed; omitted fields remain unchanged.",
      inputSchema: {
        id: scheduleIdField,
        cron: z.string().trim().min(1).optional().describe("New cron expression."),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for cron cadence; requires cron."),
        name: z.string().nullable().optional().describe("New name (null to clear)."),
        prompt: z.string().trim().min(1).optional().describe("New prompt text."),
        maxRuns: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("New max runs limit (null to clear)."),
        provider: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("New provider or provider/model for a new-agent target."),
        model: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional()
          .describe("New model for a new-agent target (null to clear)."),
        mode: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional()
          .describe("New mode for a new-agent target (null to clear)."),
        cwd: z.string().trim().min(1).optional().describe("New cwd for a new-agent target."),
        expiresIn: DurationSchema.optional().describe(
          "New relative expiry, for example 30m or 12h.",
        ),
        clearExpires: z.boolean().optional().describe("Clear any schedule expiry."),
      },
    },
    async (client, input) => {
      if (input.timezone !== undefined && input.cron === undefined) {
        throw new Error("timezone can only be used with cron");
      }
      if (input.expiresIn !== undefined && input.clearExpires) {
        throw new Error("Specify at most one of expiresIn or clearExpires");
      }
      const newAgentConfig = newAgentPatchFrom(input);
      const expiresAt = input.clearExpires ? null : expiresAtFrom(input.expiresIn);
      const { schedule } = rejectPayloadError(
        await client.scheduleUpdate({
          id: input.id,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.cron !== undefined ? { cadence: cadenceFrom(input.cron, input.timezone) } : {}),
          ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(newAgentConfig ? { newAgentConfig } : {}),
        }),
      );
      return structured(schedule);
    },
  );

  registry.hostTool(
    "list_schedules",
    {
      title: "List schedules",
      description: "List schedules on a host.",
      inputSchema: {},
    },
    async (client) => {
      const { schedules } = rejectPayloadError(await client.scheduleList());
      return structured({ schedules });
    },
  );

  registry.hostTool(
    "inspect_schedule",
    {
      title: "Inspect schedule",
      description: "Get full details of a schedule, including its target and recent runs.",
      inputSchema: { id: scheduleIdField },
    },
    async (client, { id }) => {
      const { schedule } = rejectPayloadError(await client.scheduleInspect({ id }));
      return structured(schedule);
    },
  );

  registry.hostTool(
    "schedule_logs",
    {
      title: "Schedule logs",
      description: "Get the run history (logs) for a schedule.",
      inputSchema: { id: scheduleIdField },
    },
    async (client, { id }) => {
      const { runs } = rejectPayloadError(await client.scheduleLogs({ id }));
      return structured({ runs });
    },
  );

  registry.hostTool(
    "run_schedule_once",
    {
      title: "Run schedule once",
      description: "Run a schedule immediately, outside its cadence.",
      inputSchema: { id: scheduleIdField },
    },
    async (client, { id }) => {
      const { schedule } = rejectPayloadError(await client.scheduleRunOnce({ id }));
      return structured(schedule);
    },
  );

  registry.hostTool(
    "pause_schedule",
    {
      title: "Pause schedule",
      description: "Pause a schedule so it stops running until resumed.",
      inputSchema: { id: scheduleIdField },
    },
    async (client, { id }) => {
      const { schedule } = rejectPayloadError(await client.schedulePause({ id }));
      return structured(schedule);
    },
  );

  registry.hostTool(
    "resume_schedule",
    {
      title: "Resume schedule",
      description: "Resume a paused schedule.",
      inputSchema: { id: scheduleIdField },
    },
    async (client, { id }) => {
      const { schedule } = rejectPayloadError(await client.scheduleResume({ id }));
      return structured(schedule);
    },
  );

  registry.hostTool(
    "delete_schedule",
    {
      title: "Delete schedule",
      description: "Delete a schedule permanently.",
      inputSchema: { id: scheduleIdField },
    },
    async (client, { id }) => {
      const { scheduleId } = rejectPayloadError(await client.scheduleDelete({ id }));
      return structured({ success: true, id: scheduleId });
    },
  );
}
