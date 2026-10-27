import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { structured, type McpGatewayToolRegistry } from "./tool-registry.js";

interface ProviderEntry {
  provider: string;
  label?: string;
  description?: string;
  enabled: boolean;
  modes?: unknown[];
  status: string;
  error?: string;
}

function summarize(entry: ProviderEntry) {
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    description: entry.description ?? "",
    enabled: entry.enabled,
    modes: entry.modes ?? [],
    status: entry.status === "ready" ? "available" : entry.status,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

const SNAPSHOT_SETTLE_TIMEOUT_MS = 30_000;
const SNAPSHOT_POLL_INTERVAL_MS = 250;

/**
 * A host's provider snapshot, once no provider is still loading. A snapshot
 * for a directory the host has not resolved before starts out loading; the
 * daemon tools wait for it the same way.
 */
async function settledSnapshot(client: DaemonClient, cwd: string | undefined) {
  const deadline = Date.now() + SNAPSHOT_SETTLE_TIMEOUT_MS;
  for (;;) {
    const snapshot = await client.getProvidersSnapshot(cwd ? { cwd } : undefined);
    const loading = snapshot.entries.some((entry) => entry.status === "loading");
    if (!loading || Date.now() >= deadline) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_POLL_INTERVAL_MS));
  }
}

const cwdField = z
  .string()
  .optional()
  .describe("Absolute directory on the host. Some providers resolve differently per project.");

/** What a host can run: providers, their models and modes, and configured profiles. */
export function registerProviderTools(registry: McpGatewayToolRegistry): void {
  registry.hostTool(
    "list_providers",
    {
      title: "List providers",
      description: "List a host's agent providers, their availability, and their modes.",
      inputSchema: { cwd: cwdField },
    },
    async (client, { cwd }) => {
      const { entries } = await settledSnapshot(client, cwd);
      return structured({ providers: entries.map(summarize) });
    },
  );

  registry.hostTool(
    "list_models",
    {
      title: "List models",
      description: "List models for an agent provider on a host.",
      inputSchema: { provider: z.string().trim().min(1), cwd: cwdField },
    },
    async (client, { provider, cwd }) => {
      const result = await client.listProviderModels(provider, cwd ? { cwd } : undefined);
      if (result.error) throw new Error(result.error);
      return structured({ provider, models: result.models ?? [] });
    },
  );

  registry.hostTool(
    "list_profiles",
    {
      title: "List agent profiles",
      description:
        "List agent profiles on a host: named provider/model/mode bundles a human configured for specific kinds of work. Read each profile's `notes` to pick one, then copy its `provider`, `model`, `modeId`, `thinkingOptionId`, and `featureValues` into create_agent (there is no `profile` parameter).",
      inputSchema: {},
    },
    async (client) => {
      const { config } = await client.getDaemonConfig();
      return structured({ profiles: config.agentProfiles ?? [] });
    },
  );

  registry.hostTool(
    "inspect_provider",
    {
      title: "Inspect provider",
      description:
        "Inspect a provider's capabilities on a host, including modes and draft feature settings. Use list_models for the full model list.",
      inputSchema: {
        provider: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Provider ID, optionally with a model ID (for example codex or codex/gpt-5.4).",
          ),
        cwd: z
          .string()
          .min(1)
          .describe("Absolute directory on the host used to resolve feature availability."),
        settings: z
          .object({
            modeId: z.string().optional().describe("Draft session mode ID."),
            model: z.string().optional().describe("Draft model ID."),
            thinkingOptionId: z.string().optional().describe("Draft thinking option ID."),
            features: z.record(z.string(), z.unknown()).optional(),
          })
          .strict()
          .optional()
          .describe("Draft provider settings used to compute available features."),
      },
    },
    async (client, { provider: input, cwd, settings }) => {
      const slash = input.indexOf("/");
      const provider = slash === -1 ? input : input.slice(0, slash);
      const modelFromProvider = slash === -1 ? undefined : input.slice(slash + 1) || undefined;
      const { entries } = await settledSnapshot(client, cwd);
      const entry = entries.find((candidate) => candidate.provider === provider);
      if (!entry) throw new Error(`Provider '${provider}' is not configured`);
      if (!entry.enabled) throw new Error(`Provider '${provider}' is disabled`);
      if (entry.status !== "ready") {
        throw new Error(entry.error ?? `Provider '${provider}' is unavailable`);
      }
      const selectedModel = settings?.model ?? modelFromProvider;
      const result = await client.listProviderFeatures({
        provider,
        cwd,
        ...(settings?.modeId ? { modeId: settings.modeId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(settings?.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}),
        ...(settings?.features ? { featureValues: settings.features } : {}),
      });
      if (result.error) throw new Error(result.error);
      const summary = summarize(entry);
      return structured({
        provider,
        label: summary.label,
        description: summary.description,
        enabled: summary.enabled,
        status: summary.status,
        modes: summary.modes,
        selectedModel: selectedModel ?? null,
        features: result.features ?? [],
      });
    },
  );
}
