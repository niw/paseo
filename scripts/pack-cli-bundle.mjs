// Packs this checkout's CLI and the daemon it runs into one npm tarball that a
// host runs with `npx -y ./paseo-cli-<version>-<commit>.tgz daemon restart`.
//
// NOTE: The checkout carries the published version number, so the @getpaseo
// packages are bundled to keep npm from resolving them from the registry. npm
// does not install the dependencies of bundled packages, so the tarball declares
// them itself, pinned to versions this checkout installed. A dependency whose
// ranges no single version meets is bundled under the package that needs it.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["protocol", "relay", "highlight", "plugin", "client", "server", "cli"];

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    cwd: REPO_ROOT,
    // NOTE: protocol generates its validators in prebuild and server builds the
    // daemon web UI in prepack, which `ignore-scripts=true` would skip.
    env: { ...process.env, npm_config_ignore_scripts: "false" },
    ...options,
  });
}

function gitOutput(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/** The short commit hash, marked when the working tree has uncommitted changes. */
function commitLabel() {
  const commit = gitOutput(["rev-parse", "--short", "HEAD"]);
  return gitOutput(["status", "--porcelain"]) === "" ? commit : `${commit}-dirty`;
}

function readManifest(directory) {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
}

function isInternal(name) {
  return name.startsWith("@getpaseo/");
}

/** The directory the checkout resolves `name` to from one workspace package. */
function resolvedDirectory(packageName, name) {
  const nestedDirectory = path.join(REPO_ROOT, "packages", packageName, "node_modules", name);
  return existsSync(nestedDirectory) ? nestedDirectory : path.join(REPO_ROOT, "node_modules", name);
}

/**
 * Pins each external dependency to one version that satisfies every bundled
 * package. A package whose range no shared version meets gets its own copy bundled.
 */
function collectDependencies(bundleDirectory) {
  const requirements = new Map();
  for (const packageName of PACKAGES) {
    const manifest = readManifest(path.join(REPO_ROOT, "packages", packageName));
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (isInternal(name)) continue;
      const directory = resolvedDirectory(packageName, name);
      const requirement = {
        packageName,
        range,
        directory,
        version: readManifest(directory).version,
      };
      requirements.set(name, [...(requirements.get(name) ?? []), requirement]);
    }
  }

  const dependencies = {};
  for (const [name, entries] of requirements) {
    const versions = [...new Set(entries.map((entry) => entry.version))].sort(semver.rcompare);
    const satisfiedBy = (version) =>
      entries.filter((entry) =>
        semver.satisfies(version, entry.range, { includePrerelease: true }),
      );
    const shared = versions.reduce((best, version) =>
      satisfiedBy(version).length > satisfiedBy(best).length ? version : best,
    );
    dependencies[name] = shared;
    for (const entry of entries) {
      if (!semver.satisfies(shared, entry.range, { includePrerelease: true })) {
        bundleNestedDependency({ ...entry, name, bundleDirectory });
      }
    }
  }
  return dependencies;
}

function bundleNestedDependency({ packageName, name, directory, bundleDirectory }) {
  const manifest = readManifest(directory);
  const hasInstallScripts = ["preinstall", "install", "postinstall"].some(
    (script) => manifest.scripts?.[script],
  );
  if (Object.keys(manifest.dependencies ?? {}).length > 0 || hasInstallScripts) {
    throw new Error(
      `${name}@${manifest.version} for @getpaseo/${packageName} has its own dependencies or install scripts, so it cannot be bundled as is.`,
    );
  }
  cpSync(
    directory,
    path.join(bundleDirectory, "node_modules", "@getpaseo", packageName, "node_modules", name),
    { recursive: true },
  );
}

const outputDirectory = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, "artifacts"));
const { version } = readManifest(path.join(REPO_ROOT, "packages", "cli"));
const commit = commitLabel();
const workDirectory = mkdtempSync(path.join(tmpdir(), "paseo-cli-bundle-"));

try {
  run("npm", ["run", "build:server"]);

  const tarballDirectory = path.join(workDirectory, "tarballs");
  mkdirSync(tarballDirectory);
  run("npm", [
    "pack",
    ...PACKAGES.flatMap((packageName) => ["--workspace", `@getpaseo/${packageName}`]),
    "--pack-destination",
    tarballDirectory,
  ]);

  const bundleDirectory = path.join(workDirectory, "bundle");
  for (const packageName of PACKAGES) {
    const packageDirectory = path.join(bundleDirectory, "node_modules", "@getpaseo", packageName);
    mkdirSync(packageDirectory, { recursive: true });
    run("tar", [
      "-xzf",
      path.join(tarballDirectory, `getpaseo-${packageName}-${version}.tgz`),
      "-C",
      packageDirectory,
      "--strip-components=1",
    ]);
  }

  mkdirSync(path.join(bundleDirectory, "bin"));
  const binPath = path.join(bundleDirectory, "bin", "paseo");
  writeFileSync(
    binPath,
    '#!/usr/bin/env -S node --disable-warning=DEP0040\nimport "@getpaseo/cli/dist/index.js";\n',
  );
  chmodSync(binPath, 0o755);

  const internalNames = PACKAGES.map((packageName) => `@getpaseo/${packageName}`);
  const externalDependencies = collectDependencies(bundleDirectory);
  const dependencies = Object.fromEntries(
    [...Object.entries(externalDependencies), ...internalNames.map((name) => [name, version])].sort(
      ([left], [right]) => left.localeCompare(right),
    ),
  );
  writeFileSync(
    path.join(bundleDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "paseo-cli",
        version,
        description: "Paseo CLI and daemon packed from a local checkout",
        type: "module",
        bin: { paseo: "bin/paseo" },
        dependencies,
        bundleDependencies: internalNames,
      },
      null,
      2,
    )}\n`,
  );

  // The commit in the file name tells apart builds that carry the same version.
  mkdirSync(outputDirectory, { recursive: true });
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", outputDirectory], {
    cwd: bundleDirectory,
  });
  const outputPath = path.join(outputDirectory, `paseo-cli-${version}-${commit}.tgz`);
  renameSync(path.join(outputDirectory, `paseo-cli-${version}.tgz`), outputPath);
  console.log(`Wrote ${outputPath}`);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
