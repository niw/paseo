import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Load the copies the Expo CLI uses for prebuild, not older hoisted ones.
const requireFromExpo = createRequire(require.resolve("expo/package.json"));
const requireFromExpoCli = createRequire(requireFromExpo.resolve("@expo/cli/package.json"));
const { getPrebuildConfigAsync } = requireFromExpoCli("@expo/prebuild-config");
const { compileModsAsync } = requireFromExpoCli(
  "@expo/config-plugins/build/plugins/mod-compiler.js",
);

const { withPlugins } = require("expo/config-plugins");
const withPasteInput = require("./plugins/with-paste-input");

interface ManifestEntry {
  $: Record<string, string>;
}

const originalFdroidFlag = process.env.PASEO_FDROID_BUILD;

async function resolveAndroidManifest() {
  const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["android"] });
  await compileModsAsync(exp, {
    projectRoot: __dirname,
    introspect: true,
    platforms: ["android"],
    assertMissingModProviders: false,
  });
  return exp._internal.modResults.android.manifest.manifest;
}

describe("Android app config", () => {
  afterEach(() => {
    if (originalFdroidFlag === undefined) {
      delete process.env.PASEO_FDROID_BUILD;
    } else {
      process.env.PASEO_FDROID_BUILD = originalFdroidFlag;
    }
  });

  it.each([
    ["Google Play", "0"],
    ["F-Droid", "1"],
  ])(
    "%s build installs on devices without a camera",
    async (_build, fdroidFlag) => {
      process.env.PASEO_FDROID_BUILD = fdroidFlag;
      const manifest = await resolveAndroidManifest();
      const permissions = (manifest["uses-permission"] ?? []).map(
        (entry: ManifestEntry) => entry.$["android:name"],
      );
      const features = (manifest["uses-feature"] ?? []).map((entry: ManifestEntry) => entry.$);

      expect(permissions).toContain("android.permission.CAMERA");
      expect(features).toEqual(
        expect.arrayContaining([
          { "android:name": "android.hardware.camera", "android:required": "false" },
          { "android:name": "android.hardware.camera.autofocus", "android:required": "false" },
        ]),
      );
    },
    30_000,
  );
});

describe("iOS bundle identifier", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete require.cache[require.resolve("./app.config.js")];
  });

  it.each([
    ["production", undefined, "sh.paseo", "sh.paseo"],
    ["development", undefined, "sh.paseo.debug", "sh.paseo.debug"],
    ["production", "com.example.paseo", "com.example.paseo", "sh.paseo"],
    ["development", "com.example.paseo.dev", "com.example.paseo.dev", "sh.paseo.debug"],
  ])("resolves %s with IOS_BUNDLE_ID=%s", async (variant, bundleId, expected, androidPackage) => {
    vi.stubEnv("APP_VARIANT", variant);
    vi.stubEnv("IOS_BUNDLE_ID", bundleId);
    // Expo caches the config module; each case represents a separate CLI invocation.
    delete require.cache[require.resolve("./app.config.js")];
    const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["ios"] });
    expect(exp.ios.bundleIdentifier).toBe(expected);
    expect(exp.android.package).toBe(androidPackage);
  });
});

describe("iOS app config", () => {
  it("preserves the custom scene across repeated non-clean prebuilds", async () => {
    const projectRoot = __dirname;
    const config = withPlugins({ name: "Paseo", slug: "paseo", _internal: { projectRoot } }, [
      ["expo-build-properties", { ios: { enableSceneSupport: true } }],
      withPasteInput,
    ]);
    const input = {
      ...config,
      modRequest: { projectRoot, platformProjectRoot: path.join(projectRoot, "ios") },
      modResults: {},
    };
    const first = await config.mods.ios.infoPlist(input);
    const expected = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "PaseoSceneDelegate",
          },
        ],
      },
    };
    expect(first.modResults.UIApplicationSceneManifest).toEqual(expected);
    const second = await config.mods.ios.infoPlist(first);
    expect(second.modResults.UIApplicationSceneManifest).toEqual(expected);
  });
});
