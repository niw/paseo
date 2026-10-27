import type { DaemonPermission } from "@getpaseo/protocol/messages";

export const MCP_GATEWAY_TOOL_NAMES = [
  "list_hosts",
  "list_projects",
  "list_workspaces",
  "create_workspace",
  "rename_workspace",
  "archive_workspace",
  "list_workspace_scripts",
  "start_workspace_script",
  "stop_workspace_script",
  "create_agent",
  "send_agent_prompt",
  "get_agent_status",
  "get_agent_activity",
  "list_agents",
  "wait_for_agent",
  "update_agent",
  "set_agent_mode",
  "cancel_agent",
  "archive_agent",
  "list_pending_permissions",
  "respond_to_permission",
  "list_terminals",
  "create_terminal",
  "capture_terminal",
  "send_terminal_keys",
  "kill_terminal",
  "create_schedule",
  "update_schedule",
  "list_schedules",
  "inspect_schedule",
  "schedule_logs",
  "run_schedule_once",
  "pause_schedule",
  "resume_schedule",
  "delete_schedule",
  "list_providers",
  "list_models",
  "list_profiles",
  "inspect_provider",
  "get_checkout_status",
  "get_checkout_diff",
  "commit_changes",
  "pull_changes",
  "push_changes",
  "switch_branch",
  "create_pull_request",
  "get_pull_request_status",
  "list_directory",
  "read_file",
] as const;

export type McpGatewayToolName = (typeof MCP_GATEWAY_TOOL_NAMES)[number];

/**
 * What a tool does to a host. read changes nothing; write only adds or
 * updates; destructive stops, removes or discards something. Clients see it
 * as MCP tool annotations, and exec mode asks for confirmation before a
 * destructive call.
 */
export type McpGatewayToolEffect = "read" | "write" | "destructive";

export interface McpGatewayToolPolicy {
  /** Mirrors the RPC classification in authorization/operation-permissions.ts. null is open to every authenticated caller. */
  permission: DaemonPermission | null;
  effect: McpGatewayToolEffect;
}

// Keyed by every gateway tool so a new tool fails typecheck until it is classified.
const MCP_GATEWAY_TOOL_POLICY: Record<McpGatewayToolName, McpGatewayToolPolicy> = {
  list_hosts: { permission: null, effect: "read" },
  list_projects: { permission: "workspace.read", effect: "read" },
  list_workspaces: { permission: "workspace.read", effect: "read" },
  create_workspace: { permission: "workspace.manage", effect: "write" },
  rename_workspace: { permission: "workspace.manage", effect: "write" },
  archive_workspace: { permission: "workspace.manage", effect: "destructive" },
  list_workspace_scripts: { permission: "workspace.read", effect: "read" },
  start_workspace_script: { permission: "workspace.write", effect: "write" },
  stop_workspace_script: { permission: "workspace.write", effect: "write" },
  create_agent: { permission: "workspace.write", effect: "write" },
  send_agent_prompt: { permission: "workspace.write", effect: "write" },
  get_agent_status: { permission: "workspace.read", effect: "read" },
  get_agent_activity: { permission: "workspace.read", effect: "read" },
  list_agents: { permission: "workspace.read", effect: "read" },
  wait_for_agent: { permission: "workspace.read", effect: "read" },
  update_agent: { permission: "workspace.write", effect: "write" },
  set_agent_mode: { permission: "workspace.write", effect: "write" },
  cancel_agent: { permission: "workspace.write", effect: "destructive" },
  archive_agent: { permission: "workspace.write", effect: "destructive" },
  list_pending_permissions: { permission: "workspace.read", effect: "read" },
  respond_to_permission: { permission: "workspace.write", effect: "write" },
  list_terminals: { permission: "workspace.read", effect: "read" },
  create_terminal: { permission: "workspace.write", effect: "write" },
  capture_terminal: { permission: "workspace.read", effect: "read" },
  send_terminal_keys: { permission: "workspace.write", effect: "write" },
  kill_terminal: { permission: "workspace.write", effect: "destructive" },
  create_schedule: { permission: "automation.manage", effect: "write" },
  update_schedule: { permission: "automation.manage", effect: "write" },
  list_schedules: { permission: "automation.manage", effect: "read" },
  inspect_schedule: { permission: "automation.manage", effect: "read" },
  schedule_logs: { permission: "automation.manage", effect: "read" },
  run_schedule_once: { permission: "automation.manage", effect: "write" },
  pause_schedule: { permission: "automation.manage", effect: "write" },
  resume_schedule: { permission: "automation.manage", effect: "write" },
  delete_schedule: { permission: "automation.manage", effect: "destructive" },
  list_providers: { permission: "daemon.read", effect: "read" },
  list_models: { permission: "daemon.read", effect: "read" },
  list_profiles: { permission: "daemon.read", effect: "read" },
  inspect_provider: { permission: "daemon.read", effect: "read" },
  get_checkout_status: { permission: "workspace.read", effect: "read" },
  get_checkout_diff: { permission: "workspace.read", effect: "read" },
  commit_changes: { permission: "workspace.write", effect: "write" },
  pull_changes: { permission: "workspace.write", effect: "write" },
  push_changes: { permission: "workspace.write", effect: "write" },
  switch_branch: { permission: "workspace.write", effect: "write" },
  create_pull_request: { permission: "workspace.write", effect: "write" },
  get_pull_request_status: { permission: "workspace.read", effect: "read" },
  list_directory: { permission: "workspace.read", effect: "read" },
  read_file: { permission: "workspace.read", effect: "read" },
};

export function mcpGatewayToolPolicy(toolName: McpGatewayToolName): McpGatewayToolPolicy {
  return MCP_GATEWAY_TOOL_POLICY[toolName];
}

/** null permissions are the unrestricted local stdio caller. */
export function isMcpGatewayToolAllowed(
  toolName: McpGatewayToolName,
  permissions: ReadonlySet<DaemonPermission> | null,
): boolean {
  const required = MCP_GATEWAY_TOOL_POLICY[toolName].permission;
  return required === null || permissions === null || permissions.has(required);
}

/** Whether these permissions reach any tool that acts on a host. */
export function grantsAnyMcpGatewayHostTool(permissions: ReadonlySet<DaemonPermission>): boolean {
  return Object.values(MCP_GATEWAY_TOOL_POLICY).some(
    ({ permission }) => permission !== null && permissions.has(permission),
  );
}

export class McpGatewayToolNameError extends Error {
  readonly code = "MCP_GATEWAY_UNKNOWN_TOOL";
  constructor(readonly toolNames: readonly string[]) {
    super(`Unknown gateway tools: ${toolNames.join(", ")}`);
    this.name = "McpGatewayToolNameError";
  }
}

/** Parses a comma-separated tool list, such as the tools query parameter. */
export function parseMcpGatewayToolNames(value: string): McpGatewayToolName[] {
  const requested = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const known = new Set<string>(MCP_GATEWAY_TOOL_NAMES);
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new McpGatewayToolNameError(unknown);
  return [...new Set(requested)] as McpGatewayToolName[];
}
