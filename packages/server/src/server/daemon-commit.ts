import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { execCommand } from "../utils/spawn.js";

// Written next to the compiled server by scripts/write-build-info.mjs.
const BUILD_INFO_FILE_NAME = "build-info.json";

const buildInfoSchema = z.object({ commit: z.string().min(1) });

async function readBuildInfoCommit(moduleDir: string): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(path.join(moduleDir, "..", BUILD_INFO_FILE_NAME), "utf8"),
    );
    const parsed = buildInfoSchema.safeParse(raw);
    return parsed.success ? parsed.data.commit : null;
  } catch {
    return null;
  }
}

async function readCheckoutCommit(moduleDir: string): Promise<string | null> {
  try {
    const git = async (args: string[]) =>
      (await execCommand("git", ["-C", moduleDir, ...args])).stdout.trim();
    const commit = await git(["rev-parse", "--short", "HEAD"]);
    return (await git(["status", "--porcelain"])) === "" ? commit : `${commit}-dirty`;
  } catch {
    return null;
  }
}

/**
 * The commit the daemon was built from, such as `0cc3805` or `0cc3805-dirty`.
 * A build reads the commit its build step recorded. Running from source asks git,
 * which a built install never does: git would report whatever repository encloses it.
 */
export async function resolveDaemonCommit(
  moduleUrl: string = import.meta.url,
): Promise<string | null> {
  const modulePath = fileURLToPath(moduleUrl);
  const moduleDir = path.dirname(modulePath);
  return modulePath.endsWith(".ts")
    ? readCheckoutCommit(moduleDir)
    : readBuildInfoCommit(moduleDir);
}
