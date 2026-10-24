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

const { withBaseMod, withPlugins } = require("expo/config-plugins");
const { withPasteInputScene } = require("./plugins/with-paste-input");

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

it("follows system rotation on Android", async () => {
  const manifest = await resolveAndroidManifest();
  const activity = manifest.application[0].activity.find(
    (entry: ManifestEntry) => entry.$["android:name"] === ".MainActivity",
  );
  expect(activity.$["android:screenOrientation"]).toBe("unspecified");
}, 30_000);

it("allows all orientations on iPhone and iPad", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "paseo-ios-config-"));
  try {
    const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["ios"] });
    await compileModsAsync(exp, {
      projectRoot: root,
      introspect: true,
      platforms: ["ios"],
      assertMissingModProviders: false,
    });
    const plist = exp._internal.modResults.ios.infoPlist;
    const orientations = [
      "UIInterfaceOrientationPortrait",
      "UIInterfaceOrientationPortraitUpsideDown",
      "UIInterfaceOrientationLandscapeLeft",
      "UIInterfaceOrientationLandscapeRight",
    ];
    expect(plist.UISupportedInterfaceOrientations).toEqual(orientations);
    expect(plist["UISupportedInterfaceOrientations~ipad"]).toEqual(orientations);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

// Scene startup is the integration boundary for the iOS keyboard window.
describe("hardware keyboard scene integration", () => {
  it("installs observation after Expo creates the scene window and is idempotent", () => {
    const {
      configureHardwareKeyboardAppDelegate,
    } = require("./modules/paseo-hardware-keyboard/app.plugin.js");
    const source =
      "import Expo\nclass Scene {\n  super.scene(scene, willConnectTo: session, options: connectionOptions)\n}\n";
    const configured = configureHardwareKeyboardAppDelegate(source);
    expect(configured).toContain("import PaseoHardwareKeyboard");
    expect(configured).toContain("PaseoHardwareKeyboardWindow.observing(window)");
    expect(configured.indexOf("super.scene")).toBeLessThan(
      configured.indexOf(".observing(window)"),
    );
    expect(configureHardwareKeyboardAppDelegate(configured)).toBe(configured);
  });
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
      withPasteInputScene,
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

  it("installs paste input and keyboard observation in the scene delegate", async () => {
    const template = [
      "import Expo",
      "",
      "class AppDelegate: ExpoAppDelegate {",
      "  override func application() -> Bool {",
      "    reactNativeFactory = factory",
      "",
      "    window = UIWindow(frame: UIScreen.main.bounds)",
      '    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)',
      "    return true",
      "  }",
      "}",
      "",
    ].join("\n");
    const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["ios"] });
    const config = withBaseMod(exp, {
      platform: "ios",
      mod: "appDelegate",
      isProvider: true,
      async action(modConfig: { modRequest: { nextMod: (config: object) => Promise<object> } }) {
        return modConfig.modRequest.nextMod({
          ...modConfig,
          modResults: { language: "swift", contents: template, path: "AppDelegate.swift" },
        });
      },
    });
    const result = await config.mods.ios.appDelegate({
      ...config,
      modRequest: {
        projectRoot: __dirname,
        platformProjectRoot: path.join(__dirname, "ios"),
        platform: "ios",
        modName: "appDelegate",
        introspect: false,
      },
    });
    const contents: string = result.modResults.contents;
    expect(contents).toContain("class PaseoSceneDelegate: ExpoAppSceneDelegate");
    expect(contents).toContain("PaseoHardwareKeyboardWindow.observing(window)");
    expect(contents).toContain("PasteInputModule.setup(factory.rootViewFactory)");
  }, 30_000);
});
