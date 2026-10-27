import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildSelfNodeCommand,
  createExternalCommandProcessEnv,
  createExternalProcessEnv,
  createPaseoInternalEnv,
  resolvePaseoNodeEnv,
} from "./paseo-env.js";

describe("paseo env contract", () => {
  const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";
  const PASEO_NODE_ENV = "PASEO_NODE_ENV";
  const baseEnv = {
    [ELECTRON_RUN_AS_NODE]: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "development",
    PATH: "/usr/bin",
    PASEO_AGENT_ID: "agent-123",
    PASEO_DESKTOP_MANAGED: "1",
    [PASEO_NODE_ENV]: "production",
    PASEO_SUPERVISED: "1",
    ESBUILD_BINARY_PATH: "/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/esbuild",
  };
  const runtimeControlEnvKeys = [
    "ELECTRON_RUN_AS_NODE",
    "PASEO_NODE_ENV",
    "PASEO_DESKTOP_MANAGED",
    "PASEO_SUPERVISED",
    "ELECTRON_NO_ATTACH_CONSOLE",
    "ESBUILD_BINARY_PATH",
  ] as const;

  test("builds internal daemon child env by preserving pass-through and control vars", () => {
    const env = createPaseoInternalEnv(baseEnv);

    expect(env).toMatchObject({
      [ELECTRON_RUN_AS_NODE]: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_ENV: "development",
      PATH: "/usr/bin",
      PASEO_DESKTOP_MANAGED: "1",
      [PASEO_NODE_ENV]: "production",
      PASEO_SUPERVISED: "1",
      PASEO_AGENT_ID: "agent-123",
    });
  });

  test("builds external process env by scrubbing runtime control vars after overlays", () => {
    const env = createExternalProcessEnv(baseEnv, {
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ELECTRON_RUN_AS_NODE: "0",
      EXTRA_VALUE: "from-overlay",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_NODE_ENV: "test",
      PASEO_SUPERVISED: "1",
      PATH: "/custom/bin",
    });

    for (const key of runtimeControlEnvKeys) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("applies non-control overlays to external process env", () => {
    const env = createExternalProcessEnv(baseEnv, { PATH: "/custom/bin" }, { CUSTOM: "value" });

    expect(env.CUSTOM).toBe("value");
    expect(env.NODE_ENV).toBe("development");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("builds external command env without process.execPath special-casing", () => {
    const env = createExternalCommandProcessEnv(process.execPath, baseEnv, {
      ELECTRON_RUN_AS_NODE: "0",
      PASEO_NODE_ENV: "test",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env[PASEO_NODE_ENV]).toBeUndefined();
    expect(env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("builds self node command with Electron node mode", () => {
    const command = buildSelfNodeCommand(["script.js"], {
      CUSTOM: "value",
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual(["script.js"]);
    expect(command.env[ELECTRON_RUN_AS_NODE]).toBe("1");
    expect(command.env.CUSTOM).toBe("value");
    expect(command.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(command.env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(command.env[PASEO_NODE_ENV]).toBeUndefined();
    expect(command.env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("does not add Electron node mode for non-execPath commands", () => {
    const env = createExternalCommandProcessEnv("node", baseEnv, {
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
  });

  describe("when the daemon was launched through npm", () => {
    const npmNodeGypBin =
      "/opt/homebrew/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin";
    const npmLaunchedEnv = {
      HOME: "/Users/me",
      INIT_CWD: "/Users/me",
      NODE: "/opt/homebrew/bin/node",
      PATH: [
        "/Users/me/.npm/_npx/abc/node_modules/.bin",
        "/Users/me/node_modules/.bin",
        "/node_modules/.bin",
        npmNodeGypBin,
        "/opt/homebrew/bin",
        "/usr/bin",
      ].join(path.delimiter),
      npm_command: "exec",
      npm_config_ignore_scripts: "true",
      npm_config_local_prefix: "/Users/me",
      npm_execpath: "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
      npm_lifecycle_event: "npx",
      npm_node_execpath: "/opt/homebrew/bin/node",
    };

    test("drops npm's exported config so child npm reads the project's .npmrc", () => {
      const env = createExternalProcessEnv(npmLaunchedEnv);

      expect(Object.keys(env).join(",")).not.toMatch(/(^|,)npm_/);
      expect(env.INIT_CWD).toBeUndefined();
      expect(env.NODE).toBeUndefined();
      expect(env.HOME).toBe("/Users/me");
    });

    test("drops the PATH entries npm prepended", () => {
      const env = createExternalProcessEnv(npmLaunchedEnv);

      expect(env.PATH).toBe(["/opt/homebrew/bin", "/usr/bin"].join(path.delimiter));
    });

    test("drops every stacked prefix when npm ran inside npm", () => {
      const env = createExternalProcessEnv({
        ...npmLaunchedEnv,
        PATH: ["/repo/node_modules/.bin", npmNodeGypBin, npmLaunchedEnv.PATH].join(path.delimiter),
      });

      expect(env.PATH).toBe(["/opt/homebrew/bin", "/usr/bin"].join(path.delimiter));
    });

    test("keeps npm settings passed explicitly as overlays", () => {
      const env = createExternalProcessEnv(npmLaunchedEnv, {
        npm_config_registry: "https://registry.example.com",
      });

      expect(env.npm_config_registry).toBe("https://registry.example.com");
      expect(env.npm_config_ignore_scripts).toBeUndefined();
    });
  });

  test("keeps npm settings exported by the user when npm did not launch the daemon", () => {
    const env = createExternalProcessEnv({
      PATH: "/usr/bin",
      npm_config_registry: "https://registry.example.com",
    });

    expect(env.npm_config_registry).toBe("https://registry.example.com");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("does not use user NODE_ENV as Paseo runtime mode", () => {
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development", PASEO_NODE_ENV: "production" })).toBe(
      "production",
    );
    expect(resolvePaseoNodeEnv({ NODE_ENV: "test", PASEO_NODE_ENV: "local" })).toBeUndefined();
  });
});
