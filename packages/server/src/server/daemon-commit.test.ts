import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDaemonCommit } from "./daemon-commit.js";

const createdDirs: string[] = [];

function createBuiltServer(): { root: string; moduleUrl: string } {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-daemon-commit-"));
  createdDirs.push(root);
  const moduleDir = path.join(root, "dist", "server", "server");
  mkdirSync(moduleDir, { recursive: true });
  return { root, moduleUrl: pathToFileURL(path.join(moduleDir, "daemon-commit.js")).href };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveDaemonCommit", () => {
  it("reads the commit a build recorded", async () => {
    const { root, moduleUrl } = createBuiltServer();
    writeFileSync(
      path.join(root, "dist", "server", "build-info.json"),
      JSON.stringify({ commit: "0cc3805-dirty" }),
    );

    expect(await resolveDaemonCommit(moduleUrl)).toBe("0cc3805-dirty");
  });

  it("reports no commit for a build that recorded none", async () => {
    const { moduleUrl } = createBuiltServer();

    expect(await resolveDaemonCommit(moduleUrl)).toBeNull();
  });

  it("asks git for the commit when running from source", async () => {
    expect(await resolveDaemonCommit()).toMatch(/^[0-9a-f]{7,}(-dirty)?$/);
  });
});
