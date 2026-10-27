import { z } from "zod";
import { structured, type McpGatewayToolRegistry } from "./tool-registry.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_MAX_BYTES = 2 * 1024 * 1024;

const rootField = z
  .string()
  .min(1)
  .describe("Absolute root directory on the host, such as a workspace directory.");

/** Reading a host's files, rooted at a directory such as a workspace. */
export function registerFileTools(registry: McpGatewayToolRegistry): void {
  registry.hostTool(
    "list_directory",
    {
      title: "List directory",
      description: "List the entries of a directory under a root on the host.",
      inputSchema: {
        cwd: rootField,
        path: z
          .string()
          .optional()
          .default(".")
          .describe("Directory relative to cwd. Defaults to cwd itself."),
      },
    },
    async (client, { cwd, path }) => {
      const directory = await client.listDirectory(cwd, path);
      return structured({ path: directory.path, entries: directory.entries });
    },
  );

  registry.hostTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a text file under a root on the host. Images and binary files return their metadata without content.",
      inputSchema: {
        cwd: rootField,
        path: z.string().min(1).describe("File path relative to cwd."),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(MAX_MAX_BYTES)
          .optional()
          .default(DEFAULT_MAX_BYTES)
          .describe("Largest file to read."),
      },
    },
    async (client, { cwd, path, maxBytes }) => {
      const file = await client.readFile(cwd, path, undefined, maxBytes);
      return structured({
        path: file.path,
        kind: file.kind,
        mimeType: file.mime,
        size: file.size,
        modifiedAt: file.modifiedAt,
        ...(file.kind === "text" ? { content: new TextDecoder().decode(file.bytes) } : {}),
      });
    },
  );
}
