import { z } from "zod";
import { resolveTerminalKeyToken } from "../agent/tools/terminal-key-token.js";
import { structured, type McpGatewayToolRegistry } from "./tool-registry.js";

function summarize(terminal: { id: string; name: string; cwd?: string; workspaceId?: string }) {
  return {
    id: terminal.id,
    name: terminal.name,
    cwd: terminal.cwd ?? null,
    workspaceId: terminal.workspaceId ?? null,
  };
}

/** Workspace terminals on a host: run commands, read their output, type into them. */
export function registerTerminalTools(registry: McpGatewayToolRegistry): void {
  registry.hostTool(
    "list_terminals",
    {
      title: "List terminals",
      description: "List terminals on a host, optionally only those of one workspace.",
      inputSchema: {
        workspaceId: z.string().min(1).optional().describe("Only this workspace's terminals."),
      },
    },
    async (client, { workspaceId }) => {
      const { terminals } = await client.listTerminals(undefined, undefined, { workspaceId });
      return structured({ terminals: terminals.map(summarize) });
    },
  );

  registry.hostTool(
    "create_terminal",
    {
      title: "Create terminal",
      description:
        "Create a terminal in a workspace. Without command it starts the user's shell; use send_terminal_keys to type into it and capture_terminal to read it.",
      inputSchema: {
        workspaceId: z.string().min(1).describe("Workspace that owns the terminal."),
        cwd: z
          .string()
          .optional()
          .describe("Absolute working directory on the host. Defaults to the workspace directory."),
        name: z.string().optional().describe("Optional terminal name."),
        command: z.string().optional().describe("Program to run instead of the shell."),
        args: z.array(z.string()).optional().describe("Arguments for command."),
      },
    },
    async (client, { workspaceId, cwd, name, command, args }) => {
      let directory = cwd;
      if (!directory) {
        const { entries } = await client.fetchWorkspaces({ includeBackground: true });
        const workspace = entries.find((entry) => entry.id === workspaceId);
        if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
        directory = workspace.workspaceDirectory;
      }
      const result = await client.createTerminal(directory, name?.trim() || undefined, undefined, {
        workspaceId,
        ...(command ? { command } : {}),
        ...(args ? { args } : {}),
      });
      if (result.error || !result.terminal) {
        throw new Error(result.error ?? "The host did not create a terminal");
      }
      return structured(summarize(result.terminal));
    },
  );

  registry.hostTool(
    "capture_terminal",
    {
      title: "Capture terminal",
      description: "Capture plain-text terminal output lines from a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
        scrollback: z.boolean().optional().describe("Capture from the start of scrollback."),
        stripAnsi: z.boolean().optional().default(true),
      },
    },
    async (client, { terminalId, start, end, scrollback, stripAnsi }) => {
      const capture = await client.captureTerminal(terminalId, {
        start: scrollback ? 0 : start,
        end,
        stripAnsi,
      });
      return structured({ terminalId, lines: capture.lines, totalLines: capture.totalLines });
    },
  );

  registry.hostTool(
    "send_terminal_keys",
    {
      title: "Send terminal keys",
      description:
        "Send text or a key token: Enter, Tab, Escape, Space, BSpace, Up, Down, Left, Right, Home, End, Insert, Delete, PageUp, PageDown, or F1-F12. Combine C- (Ctrl), M- (Alt), and S- (Shift) prefixes, e.g. C-r, S-Tab, or C-M-Left. Set literal=true to send the text unchanged.",
      inputSchema: {
        terminalId: z.string(),
        keys: z.string(),
        literal: z.boolean().optional(),
      },
    },
    async (client, { terminalId, keys, literal = false }) => {
      // Input is fire-and-forget, so check the terminal exists first.
      const { terminals } = await client.listTerminals();
      if (!terminals.some((terminal) => terminal.id === terminalId)) {
        throw new Error(`Terminal ${terminalId} not found`);
      }
      // The gateway cannot see the terminal's recent output, so keys are
      // encoded for the default input mode rather than any mode a full-screen
      // program has switched on. Most such programs accept both encodings.
      client.sendTerminalInput(terminalId, {
        type: "input",
        data: resolveTerminalKeyToken({ key: keys, literal, preamble: "" }),
      });
      return structured({ success: true });
    },
  );

  registry.hostTool(
    "kill_terminal",
    {
      title: "Kill terminal",
      description: "Kill an existing terminal session.",
      inputSchema: { terminalId: z.string() },
    },
    async (client, { terminalId }) => {
      const { success } = await client.killTerminal(terminalId);
      if (!success) throw new Error(`Terminal ${terminalId} not found`);
      return structured({ success: true });
    },
  );
}
