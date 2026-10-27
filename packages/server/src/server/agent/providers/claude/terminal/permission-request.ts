import type {
  AgentMetadata,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionUpdate,
  AgentProvider,
} from "../../../agent-sdk-types.js";
import {
  buildClaudePlanPermissionActions,
  buildClaudeQuestionPermissionSummary,
  isPermissionUpdate,
  normalizeClaudeAskUserQuestionRequestInput,
  normalizeClaudeAskUserQuestionUpdatedInput,
  resolvePermissionKind,
} from "../agent.js";
import { mapClaudeRunningToolCall } from "../tool-call-mapper.js";

// NOTE: These build requests and answers the way the Claude SDK session does inline, so a
// request reads the same in either provider.

export interface ClaudePermissionRequestParams {
  requestId: string;
  provider: AgentProvider;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  suggestions?: AgentPermissionUpdate[];
}

/** The permission request for a tool call Claude Code asks about. */
export function buildClaudePermissionRequest(
  params: ClaudePermissionRequestParams,
): AgentPermissionRequest {
  const { requestId, toolName, input, toolUseId } = params;
  const kind = resolvePermissionKind(toolName, input);
  const metadata: AgentMetadata = {};
  if (toolUseId) {
    metadata.toolUseId = toolUseId;
  }
  if (toolName === "ExitPlanMode" && typeof input.plan === "string") {
    metadata.planText = input.plan;
  }
  const toolDetail =
    kind === "tool"
      ? mapClaudeRunningToolCall({
          name: toolName,
          callId: toolUseId ?? requestId,
          input,
          output: null,
        })?.detail
      : undefined;
  return {
    id: requestId,
    provider: params.provider,
    name: toolName,
    kind,
    ...buildClaudeQuestionPermissionSummary(toolName, input),
    input: normalizeClaudeAskUserQuestionRequestInput(toolName, input),
    detail: toolDetail,
    suggestions: params.suggestions?.map((suggestion) => ({ ...suggestion })),
    actions: kind === "plan" ? buildClaudePlanPermissionActions(null) : undefined,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

/** The tool input Claude Code runs once the user allows a permission request. */
export function resolveClaudeAllowedInput(
  request: AgentPermissionRequest,
  response: Extract<AgentPermissionResponse, { behavior: "allow" }>,
): Record<string, unknown> {
  return request.kind === "question"
    ? normalizeClaudeAskUserQuestionUpdatedInput(response.updatedInput, request.input ?? undefined)
    : (response.updatedInput ?? request.input ?? {});
}

export function normalizeClaudePermissionUpdates(
  updates?: AgentPermissionUpdate[],
): AgentPermissionUpdate[] | undefined {
  if (!updates || updates.length === 0) {
    return undefined;
  }
  const normalized = updates.filter(isPermissionUpdate);
  return normalized.length > 0 ? normalized : undefined;
}
