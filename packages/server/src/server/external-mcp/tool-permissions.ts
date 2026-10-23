import type { DaemonPermission } from "@getpaseo/protocol/messages";
import type { PaseoToolName } from "@getpaseo/protocol/paseo-tool-presentation/index";

// Mirrors the RPC classification in authorization/operation-permissions.ts.
// Keyed by the full catalog so a new tool fails typecheck until it is
// classified. null keeps a tool off the external listener entirely.
const EXTERNAL_TOOL_PERMISSION: Record<PaseoToolName, DaemonPermission | null> = {
  create_agent: "workspace.write",
  send_agent_prompt: "workspace.write",
  get_agent_status: "workspace.read",
  get_agent_activity: "workspace.read",
  list_agents: "workspace.read",
  update_agent: "workspace.write",
  set_agent_mode: "workspace.write",
  cancel_agent: "workspace.write",
  archive_agent: "workspace.write",
  kill_agent: "workspace.write",
  list_pending_permissions: "workspace.read",
  respond_to_permission: "workspace.write",

  create_workspace: "workspace.manage",
  list_workspaces: "workspace.read",
  rename_workspace: "workspace.manage",
  archive_workspace: "workspace.manage",
  list_workspace_scripts: "workspace.read",
  start_workspace_script: "workspace.write",
  stop_workspace_script: "workspace.write",

  create_terminal: "workspace.write",
  list_terminals: "workspace.read",
  capture_terminal: "workspace.read",
  send_terminal_keys: "workspace.write",
  kill_terminal: "workspace.write",

  create_schedule: "automation.manage",
  create_heartbeat: "automation.manage",
  update_schedule: "automation.manage",
  list_schedules: "automation.manage",
  inspect_schedule: "automation.manage",
  schedule_logs: "automation.manage",
  run_schedule_once: "automation.manage",
  pause_schedule: "automation.manage",
  resume_schedule: "automation.manage",
  delete_schedule: "automation.manage",
  delete_heartbeat: "automation.manage",

  list_hosts: "daemon.read",
  list_providers: "daemon.read",
  list_models: "daemon.read",
  list_profiles: "daemon.read",
  inspect_provider: "daemon.read",

  // Browser tools drive the desktop app's browser pane for the agent that owns
  // it. An external caller has no pane.
  browser_list_tabs: null,
  browser_new_tab: null,
  browser_close_tab: null,
  browser_navigate: null,
  browser_back: null,
  browser_forward: null,
  browser_reload: null,
  browser_snapshot: null,
  browser_screenshot: null,
  browser_click: null,
  browser_hover: null,
  browser_drag: null,
  browser_fill: null,
  browser_select: null,
  browser_type: null,
  browser_keypress: null,
  browser_upload: null,
  browser_wait: null,
  browser_scroll: null,
  browser_resize: null,
  browser_logs: null,
  browser_evaluate: null,
};

/** Tools outside the catalog (such as speak) are never exposed externally. */
export function isToolAllowedForExternalCaller(
  toolName: string,
  permissions: ReadonlySet<DaemonPermission>,
): boolean {
  if (!Object.hasOwn(EXTERNAL_TOOL_PERMISSION, toolName)) {
    return false;
  }
  const required = EXTERNAL_TOOL_PERMISSION[toolName as PaseoToolName];
  return required !== null && permissions.has(required);
}

/** Whether any external tool is reachable with these permissions. */
export function grantsAnyExternalTool(permissions: ReadonlySet<DaemonPermission>): boolean {
  return Object.values(EXTERNAL_TOOL_PERMISSION).some(
    (required) => required !== null && permissions.has(required),
  );
}
