import { z } from "zod";
import { structured, type McpGatewayToolRegistry } from "./tool-registry.js";

interface CheckoutError {
  code: string;
  message: string;
}

interface DiffFile {
  path: string;
  oldPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  additions: number;
  deletions: number;
  status?: "ok" | "too_large" | "binary";
  hunks: Array<{
    lines: Array<{ type: "add" | "remove" | "context" | "header"; content: string }>;
  }>;
}

/** Checkout RPCs report failure in the payload as a coded error instead of rejecting. */
function rejectCheckoutError<T extends { error: CheckoutError | null }>(payload: T): T {
  if (payload.error) {
    throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
  }
  return payload;
}

/** Renders a parsed diff file back to unified diff text, without highlighting. */
function toUnifiedDiff(file: DiffFile): string {
  const oldPath = file.isNew ? "/dev/null" : `a/${file.oldPath ?? file.path}`;
  const newPath = file.isDeleted ? "/dev/null" : `b/${file.path}`;
  const lines = [`--- ${oldPath}`, `+++ ${newPath}`];
  if (file.status === "too_large" || file.status === "binary") {
    lines.push(`(${file.status === "binary" ? "binary file" : "diff too large"})`);
  }
  const prefix = { add: "+", remove: "-", context: " ", header: "" } as const;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) lines.push(`${prefix[line.type]}${line.content}`);
  }
  return lines.join("\n");
}

const cwdField = z.string().min(1).describe("Absolute checkout directory on the host.");

/** Git state of a workspace checkout: status, diffs, commits, sync and pull requests. */
export function registerCheckoutTools(registry: McpGatewayToolRegistry): void {
  registry.hostTool(
    "get_checkout_status",
    {
      title: "Get checkout status",
      description:
        "Return a checkout's branch, dirty state, base ref, and ahead/behind counts against its base and origin.",
      inputSchema: { cwd: cwdField },
    },
    async (client, { cwd }) => {
      const { requestId: _requestId, ...status } = rejectCheckoutError(
        await client.getCheckoutStatus(cwd),
      );
      return structured(status);
    },
  );

  registry.hostTool(
    "get_checkout_diff",
    {
      title: "Get checkout diff",
      description:
        "Return a checkout's changes as unified diff text: uncommitted changes, changes against the base branch, or both.",
      inputSchema: {
        cwd: cwdField,
        mode: z
          .enum(["uncommitted", "base", "all"])
          .optional()
          .default("uncommitted")
          .describe("uncommitted: working tree; base: commits since the base; all: both."),
        baseRef: z
          .string()
          .optional()
          .describe("Base ref for base and all. Defaults to the checkout's base."),
        ignoreWhitespace: z.boolean().optional(),
      },
    },
    async (client, { cwd, mode, baseRef, ignoreWhitespace }) => {
      const payload = rejectCheckoutError(
        await client.getCheckoutDiff(cwd, {
          mode,
          ...(baseRef ? { baseRef } : {}),
          ...(ignoreWhitespace !== undefined ? { ignoreWhitespace } : {}),
        }),
      );
      return structured({
        cwd,
        files: payload.files.map((file) => ({
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          additions: file.additions,
          deletions: file.deletions,
          diff: toUnifiedDiff(file),
        })),
        ...(payload.diffTooLarge ? { diffTooLarge: true } : {}),
      });
    },
  );

  registry.hostTool(
    "commit_changes",
    {
      title: "Commit changes",
      description:
        "Commit a checkout's staged changes, or every change with addAll. Without a message the host generates one.",
      inputSchema: {
        cwd: cwdField,
        message: z.string().optional().describe("Commit message."),
        addAll: z.boolean().optional().describe("Stage every change before committing."),
      },
    },
    async (client, { cwd, message, addAll }) => {
      rejectCheckoutError(await client.checkoutCommit(cwd, { message, addAll }));
      return structured({ success: true, cwd });
    },
  );

  registry.hostTool(
    "pull_changes",
    {
      title: "Pull changes",
      description: "Pull the current branch from its upstream.",
      inputSchema: { cwd: cwdField },
    },
    async (client, { cwd }) => {
      rejectCheckoutError(await client.checkoutPull(cwd));
      return structured({ success: true, cwd });
    },
  );

  registry.hostTool(
    "push_changes",
    {
      title: "Push changes",
      description: "Push the current branch to its remote.",
      inputSchema: { cwd: cwdField },
    },
    async (client, { cwd }) => {
      rejectCheckoutError(await client.checkoutPush(cwd));
      return structured({ success: true, cwd });
    },
  );

  registry.hostTool(
    "switch_branch",
    {
      title: "Switch branch",
      description: "Switch a checkout to an existing local or remote branch.",
      inputSchema: { cwd: cwdField, branch: z.string().min(1) },
    },
    async (client, { cwd, branch }) => {
      const result = rejectCheckoutError(await client.checkoutSwitchBranch(cwd, branch));
      return structured({ success: true, cwd, branch: result.branch, source: result.source });
    },
  );

  registry.hostTool(
    "create_pull_request",
    {
      title: "Create pull request",
      description:
        "Open a pull request (or change request) for the checkout's current branch on its forge. Push the branch first.",
      inputSchema: {
        cwd: cwdField,
        title: z.string().optional().describe("Title. Without one the host generates it."),
        body: z.string().optional(),
        baseRef: z.string().optional().describe("Target branch. Defaults to the checkout's base."),
      },
    },
    async (client, { cwd, title, body, baseRef }) => {
      const result = rejectCheckoutError(
        await client.checkoutPrCreate(cwd, { title, body, baseRef }),
      );
      return structured({ cwd, url: result.url, number: result.number });
    },
  );

  registry.hostTool(
    "get_pull_request_status",
    {
      title: "Get pull request status",
      description:
        "Return the pull request for the checkout's current branch, with its state, checks and review status.",
      inputSchema: { cwd: cwdField },
    },
    async (client, { cwd }) => {
      const result = rejectCheckoutError(await client.checkoutPrStatus(cwd));
      return structured({ cwd, forge: result.forge, status: result.status });
    },
  );
}
