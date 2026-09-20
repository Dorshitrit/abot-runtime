import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import {
  getRuntimePluginSnapshot,
  setRuntimePluginEnabled,
} from "../../web-ui/plugin-management-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(plugins?: unknown) {
  const rootDir = await mkdtemp(join(tmpdir(), "plugin-management-"));
  roots.push(rootDir);
  const configPath = join(rootDir, "runtime.config.json");
  const rootConfig = {
    models: { providers: { sample: { apiKey: "private-test-value" } } },
    environment: { default: "work" },
    ...(plugins === undefined ? {} : { plugins }),
  };
  await writeFile(configPath, JSON.stringify(rootConfig));
  const manifest = JSON.parse(
    await readFile(
      join(process.cwd(), "plugins", "system-probe", "plugin.json"),
      "utf8",
    ),
  );
  manifest.name = "managed-example";
  manifest.description = "Example management fixture";
  const extension = manifest.extensions[ABOT_RUNTIME_EXTENSION];
  const capability = Object.values(extension.capabilities)[0];
  extension.capabilities = {
    first_lookup: capability,
    second_lookup: capability,
  };
  extension.entrypoint = "./never-load.cjs";
  extension.secrets = {
    sample: {
      env: "UNAVAILABLE_PLUGIN_MANAGEMENT_TEST_SECRET",
      required: true,
    },
  };
  const pluginRoot = join(rootDir, "plugins", manifest.name);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(manifest));
  return { rootDir, configPath, rootConfig };
}

function managed(snapshot: ReturnType<typeof getRuntimePluginSnapshot>) {
  return snapshot.plugins.find((plugin) => plugin.id === "managed-example");
}

describe("plugin configuration management", () => {
  test("lists manifest metadata before setup without loading code or requiring secrets", async () => {
    const options = await fixture();
    await rm(options.configPath);
    const snapshot = getRuntimePluginSnapshot(options);
    expect(managed(snapshot)).toMatchObject({
      capabilityCount: 2,
      selectedCapabilityCount: 2,
      state: "enabled",
    });
    expect(
      snapshot.plugins.some((plugin) => plugin.id === "system-probe"),
    ).toBe(true);
    expect(snapshot.application).toBe("restart_required");
    expect(JSON.stringify(snapshot)).not.toContain(
      "UNAVAILABLE_PLUGIN_MANAGEMENT_TEST_SECRET",
    );
    expect(await readdir(options.rootDir)).toEqual(["plugins"]);
  });

  test("disable and re-enable preserve a partial allow list and unrelated root values", async () => {
    const selection = {
      enabled: true,
      allow: ["managed-example.first_lookup"],
      deny: ["unrelated_tool"],
    };
    const options = await fixture(selection);
    expect(managed(getRuntimePluginSnapshot(options))?.state).toBe("partial");
    const disabled = await setRuntimePluginEnabled(options, {
      pluginId: "managed-example",
      enabled: false,
    });
    expect(managed(disabled)?.selectedCapabilityCount).toBe(0);
    expect(disabled.restartRequired).toBe(true);
    expect(disabled.backupPath).toBeTruthy();
    expect(
      JSON.parse(
        await readFile(join(options.rootDir, disabled.backupPath!), "utf8"),
      ),
    ).toEqual(options.rootConfig);

    const enabled = await setRuntimePluginEnabled(options, {
      pluginId: "managed-example",
      enabled: true,
    });
    expect(managed(enabled)).toMatchObject({
      selectedCapabilityCount: 1,
      state: "partial",
    });
    const saved = JSON.parse(await readFile(options.configPath, "utf8"));
    expect(saved).toEqual(options.rootConfig);
    expect(JSON.stringify(enabled)).not.toContain("private-test-value");
  });

  test("adds an unselected plugin while retaining capability denies", async () => {
    const options = await fixture({
      allow: ["system-probe"],
      deny: ["second_lookup"],
    });
    const result = await setRuntimePluginEnabled(options, {
      pluginId: "managed-example",
      enabled: true,
    });
    expect(managed(result)).toMatchObject({
      selectedCapabilityCount: 1,
      state: "partial",
    });
    expect(result.selection.allow).toEqual(["managed-example", "system-probe"]);
    expect(result.selection.deny).toEqual(["second_lookup"]);
  });

  test.each([
    { enabled: false, allow: ["*"] },
    { allow: ["*"], deny: ["*"] },
  ])("never bypasses global restrictions: %j", async (selection) => {
    const options = await fixture(selection);
    const result = await setRuntimePluginEnabled(options, {
      pluginId: "managed-example",
      enabled: true,
    });
    expect(managed(result)).toMatchObject({
      state: "disabled",
      blockedByGlobalPolicy: true,
    });
    expect(
      JSON.parse(await readFile(options.configPath, "utf8")).plugins,
    ).toEqual(selection);
  });

  test.each([
    { pluginId: "absent", enabled: true },
    { pluginId: "managed-example", enabled: "true" },
    { pluginId: "managed-example", enabled: true, config: {} },
  ])(
    "invalid updates leave configuration and backups untouched: %j",
    async (input) => {
      const options = await fixture();
      const before = await readFile(options.configPath, "utf8");
      await expect(setRuntimePluginEnabled(options, input)).rejects.toThrow();
      expect(await readFile(options.configPath, "utf8")).toBe(before);
      expect(
        (await readdir(options.rootDir)).filter((name) =>
          name.endsWith(".bak"),
        ),
      ).toEqual([]);
    },
  );

  test("requires setup before a plugin mutation", async () => {
    const options = await fixture();
    await rm(options.configPath);
    await expect(
      setRuntimePluginEnabled(options, {
        pluginId: "managed-example",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "runtime_setup_required" });
    expect(await readdir(options.rootDir)).toEqual(["plugins"]);
  });
});
