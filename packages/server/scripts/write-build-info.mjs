// Records the commit this build came from, which the daemon reports in server_info.
// See src/server/daemon-commit.ts.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(packageDir, "dist/server/build-info.json");

function git(args) {
  return execFileSync("git", args, {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

let commit = null;
try {
  const head = git(["rev-parse", "--short", "HEAD"]);
  commit = git(["status", "--porcelain"]) === "" ? head : `${head}-dirty`;
} catch {
  // A source build without git (a tarball, F-Droid) reports no commit.
}

if (commit) {
  writeFileSync(destination, `${JSON.stringify({ commit })}\n`);
} else {
  rmSync(destination, { force: true });
}
