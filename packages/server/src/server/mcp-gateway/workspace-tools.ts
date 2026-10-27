import { z } from "zod";
import { createRemoteHostOperations } from "../agent/host-operations/index.js";
import { rejectPayloadError, structured, type McpGatewayToolRegistry } from "./tool-registry.js";

/** Projects, workspaces and their scripts on a host. */
export function registerWorkspaceTools(registry: McpGatewayToolRegistry): void {
  registry.hostTool(
    "list_projects",
    {
      title: "List projects",
      description: "List projects on a host. Pass a project's id as projectId to create_workspace.",
      inputSchema: {},
    },
    async (client) => {
      const { projects } = await client.listProjects();
      return structured({ projects });
    },
  );

  registry.hostTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description: "List active workspaces on a host.",
      inputSchema: { includeBackground: z.boolean().optional().default(false) },
    },
    (client, args) => createRemoteHostOperations(client, null).listWorkspaces(args, {}),
  );

  registry.hostTool(
    "create_workspace",
    {
      title: "Create workspace",
      description:
        "Create a workspace on a host using an existing checkout or a new Paseo-managed worktree.",
      inputSchema: {
        isolation: z.enum(["local", "worktree"]),
        path: z
          .string()
          .min(1)
          .describe(
            "Absolute directory or source checkout on the host. Local isolation adopts an existing directory and never creates one.",
          ),
        projectId: z.string().optional().describe("Existing project id to own the workspace."),
        title: z.string().trim().min(1).optional(),
        background: z
          .boolean()
          .optional()
          .describe("True hides the workspace from default lists and the sidebar."),
        mode: z
          .enum(["branch-off", "checkout-branch", "checkout-pr"])
          .optional()
          .describe("Worktree creation mode. Defaults to branch-off."),
        worktreeSlug: z.string().trim().min(1).optional(),
        branchName: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("New branch name for branch-off mode."),
        baseBranch: z.string().trim().min(1).optional().describe("Base ref for branch-off mode."),
        branch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Existing branch for checkout-branch mode."),
        prNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pull request or change request number for checkout-pr mode."),
      },
    },
    (client, args) => createRemoteHostOperations(client, null).createWorkspace(args, {}),
  );

  registry.hostTool(
    "rename_workspace",
    {
      title: "Rename workspace",
      description: "Rename a workspace by setting its user-visible title.",
      inputSchema: {
        workspaceId: z.string().trim().min(1).describe("Workspace id to rename."),
        title: z
          .string()
          .trim()
          .min(1, "title is required")
          .describe("New user-visible workspace title."),
      },
    },
    async (client, { workspaceId, title }) => {
      const result = await client.setWorkspaceTitle(workspaceId, title);
      return structured({ success: true, workspaceId, title: result.title });
    },
  );

  registry.hostTool(
    "archive_workspace",
    {
      title: "Archive workspace",
      description: "Archive a workspace and everything it owns.",
      inputSchema: { workspaceId: z.string().min(1) },
    },
    async (client, { workspaceId }) => {
      const { archivedAt } = rejectPayloadError(await client.archiveWorkspace(workspaceId));
      return structured({ workspaceId, archivedAt });
    },
  );

  registry.hostTool(
    "list_workspace_scripts",
    {
      title: "List workspace scripts",
      description:
        "List configured workspace scripts and their lifecycle, service port, proxy URL, health, and terminal ID.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID whose configured scripts to list."),
      },
    },
    async (client, { workspaceId }) => {
      const { scripts } = rejectPayloadError(await client.listWorkspaceScripts(workspaceId));
      return structured({ scripts: scripts ?? [] });
    },
  );

  registry.hostTool(
    "start_workspace_script",
    {
      title: "Start workspace script",
      description:
        "Start one configured workspace script through Paseo's managed workspace-script launcher.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the configured script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to start."),
      },
    },
    async (client, { workspaceId, scriptName }) => {
      const { script } = rejectPayloadError(
        await client.startWorkspaceScriptWithStatus(workspaceId, scriptName),
      );
      return structured({ script: script ?? null });
    },
  );

  registry.hostTool(
    "stop_workspace_script",
    {
      title: "Stop workspace script",
      description: "Stop a running workspace script through its supervised terminal lifecycle.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the running script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to stop."),
      },
    },
    async (client, { workspaceId, scriptName }) => {
      const { script } = rejectPayloadError(
        await client.stopWorkspaceScript(workspaceId, scriptName),
      );
      return structured({ script: script ?? null });
    },
  );
}
