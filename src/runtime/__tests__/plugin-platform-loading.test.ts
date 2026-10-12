import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ABOT_PLUGIN_COMPATIBILITY_EXTENSION } from "../../plugin-contract/platform-compatibility.js";
import { discoverAgentPluginManifests } from "../plugins/manifest-discovery.js";
import {
  loadBundledRuntimePlugins,
  loadConfiguredRuntimePlugins,
} from "../plugins/loader.js";
import {
  PluginConfigurationError,
  pluginConfigurationPath,
} from "../plugins/configuration-store.js";
import {
  createPluginSelectionFixture,
  removePluginSelectionFixtures,
} from "./plugin-selection-fixture.js";

const bundled = vi.hoisted(() => ({ root: "" }));
vi.mock("../plugins/bundled-root.js", () => ({
  resolveBundledRuntimeRoot: () => bundled.root,
}));

afterEach(async () => {
  vi.unstubAllGlobals();
  await removePluginSelectionFixtures();
});

async function fixture(options: {
  platform: NodeJS.Platform;
  declaredPlatforms?: string[];
  entrypoint?: "missing" | "throws";
  requiredSecret?: boolean;
  settings?: boolean;
}) {
  const config = await createPluginSelectionFixture({
    allow: ["fixture-active"],
  });
  bundled.root = config.paths.rootDir;
  const runtimeProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(runtimeProcess, "platform", {
    value: options.platform,
  });
  Object.defineProperty(runtimeProcess, "cwd", {
    value: () => config.paths.rootDir,
  });
  vi.stubGlobal("process", runtimeProcess);
  const pluginRoot = join(config.paths.rootDir, "plugins", "fixture-active");
  const manifestPath = join(pluginRoot, "plugin.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  if (options.declaredPlatforms)
    raw.extensions[ABOT_PLUGIN_COMPATIBILITY_EXTENSION] = {
      version: 1,
      runtimePlatforms: options.declaredPlatforms,
    };
  if (options.requiredSecret)
    raw.extensions["ai.abot.runtime"].secrets = {
      token: { env: "ABOT_PLATFORM_TEST_MISSING_TOKEN", required: true },
    };
  if (options.settings)
    raw.extensions["ai.abot.runtime"].settings = { defaults: { count: 1 } };
  await writeFile(manifestPath, JSON.stringify(raw));
  const entrypoint = join(pluginRoot, "src", "index.cjs");
  if (options.entrypoint === "missing") await rm(entrypoint);
  if (options.entrypoint === "throws")
    await writeFile(
      entrypoint,
      'throw new Error("platform fixture imported");',
    );
  return config;
}

async function storedConfiguration(rootDir: string, content: string) {
  await mkdir(join(rootDir, ".runtime"), { recursive: true });
  await writeFile(pluginConfigurationPath(rootDir), content, { mode: 0o600 });
}

const loaders = [
  { name: "configured", load: loadConfiguredRuntimePlugins },
  { name: "bundled", load: () => loadBundledRuntimePlugins() },
] as const;

describe.each(loaders)("$name plugin platform loading", ({ load }) => {
  test.each(["linux", "darwin", "win32"] as const)(
    "loads and executes a real CommonJS plugin declared for %s",
    async (platform) => {
      const config = await fixture({ platform, declaredPlatforms: [platform] });
      const loaded = load(config);
      expect(loaded.map((plugin) => plugin.id)).toEqual(["fixture-active"]);
      expect(
        await loaded[0]!.capabilities[0]!.execute({} as never),
      ).toMatchObject({
        ok: true,
        output: "fixture:1",
      });
    },
  );

  test.each(["linux", "darwin"] as const)(
    "keeps legacy plugins loadable on %s",
    async (platform) => {
      const config = await fixture({ platform });
      expect(load(config).map((plugin) => plugin.id)).toEqual([
        "fixture-active",
      ]);
    },
  );

  test("keeps undeclared Windows plugins discoverable without importing them", async () => {
    const config = await fixture({ platform: "win32", entrypoint: "throws" });
    expect(discoverAgentPluginManifests(config.paths.rootDir)).toHaveLength(1);
    expect(load(config)).toEqual([]);
  });

  test("skips mismatched plugins before entrypoint projection or configuration reads", async () => {
    const config = await fixture({
      platform: "win32",
      declaredPlatforms: ["linux"],
      entrypoint: "missing",
      requiredSecret: true,
    });
    await storedConfiguration(config.paths.rootDir, "invalid JSON");
    expect(load(config)).toEqual([]);
  });

  test("skips mismatched plugins with retained setting conflicts and missing secrets", async () => {
    const config = await fixture({
      platform: "linux",
      declaredPlatforms: ["win32"],
      entrypoint: "throws",
      requiredSecret: true,
      settings: true,
    });
    await storedConfiguration(
      config.paths.rootDir,
      JSON.stringify({
        version: 1,
        plugins: {
          "fixture-active": { settings: { count: "wrong type" }, secrets: {} },
        },
      }),
    );
    expect(load(config)).toEqual([]);
  });

  test("a blocked plugin cannot stop compatible code from loading beside it", async () => {
    const config = await fixture({
      platform: "win32",
      declaredPlatforms: ["linux"],
      entrypoint: "throws",
      requiredSecret: true,
      settings: true,
    });
    config.plugins = { allow: ["*"] };
    const compatibleRoot = join(config.paths.rootDir, "plugins", "compatible");
    await mkdir(join(compatibleRoot, "src"), { recursive: true });
    const raw = JSON.parse(
      await readFile(
        join(config.paths.rootDir, "plugins", "fixture-active", "plugin.json"),
        "utf8",
      ),
    );
    raw.name = "compatible";
    raw.extensions[ABOT_PLUGIN_COMPATIBILITY_EXTENSION].runtimePlatforms = [
      "win32",
    ];
    delete raw.extensions["ai.abot.runtime"].secrets;
    delete raw.extensions["ai.abot.runtime"].settings;
    raw.extensions["ai.abot.runtime"].capabilities.fixture_ping.skills = [];
    await writeFile(join(compatibleRoot, "plugin.json"), JSON.stringify(raw));
    await writeFile(
      join(compatibleRoot, "src", "index.cjs"),
      'module.exports = {handlers: {fixture_ping: async () => ({ok: true, output: "compatible", producedNewInformation: true})}};',
    );
    await storedConfiguration(
      config.paths.rootDir,
      JSON.stringify({
        version: 1,
        plugins: {
          "fixture-active": { settings: { count: "wrong type" }, secrets: {} },
        },
      }),
    );
    const plugins = load(config);
    expect(plugins.map((plugin) => plugin.id)).toEqual(["compatible"]);
    expect(
      await plugins[0]!.capabilities[0]!.execute({} as never),
    ).toMatchObject({
      output: "compatible",
    });
  });

  test("still imports matching plugins and reports their load errors", async () => {
    const config = await fixture({
      platform: "win32",
      declaredPlatforms: ["win32"],
      entrypoint: "throws",
    });
    expect(() => load(config)).toThrow("platform fixture imported");
  });

  test("preserves configuration errors for an unchanged empty catalog", async () => {
    const config = await fixture({ platform: "linux" });
    await rm(join(config.paths.rootDir, "plugins", "fixture-active"), {
      recursive: true,
    });
    await storedConfiguration(config.paths.rootDir, "invalid JSON");
    expect(() => load(config)).toThrow(PluginConfigurationError);
  });
});

test("an ordinary empty selection retains configuration validation", async () => {
  const config = await fixture({ platform: "linux" });
  config.plugins = { allow: ["unselected"] };
  await storedConfiguration(config.paths.rootDir, "invalid JSON");
  expect(() => loadConfiguredRuntimePlugins(config)).toThrow(
    PluginConfigurationError,
  );
});
