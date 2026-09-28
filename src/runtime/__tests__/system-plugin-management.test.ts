import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getRuntimePluginSnapshot,
  setRuntimePluginEnabled,
} from "../../web-ui/plugin-management-service.js";
import type { RuntimePluginConfig } from "../ports.js";

const roots: string[] = [];
const artifactRoot = join(
  process.cwd(),
  ".codex",
  "artifacts",
  "system-plugin-management-20260918",
);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(plugins?: RuntimePluginConfig) {
  await mkdir(artifactRoot, { recursive: true });
  const rootDir = await mkdtemp(join(artifactRoot, "consumer-"));
  roots.push(rootDir);
  const configPath = join(rootDir, "runtime.config.json");
  const config = {
    models: { providers: { sample: { apiKey: "fixture-private-value" } } },
    environment: { default: "work" },
    ...(plugins === undefined ? {} : { plugins }),
  };
  await writeFile(configPath, JSON.stringify(config));
  return { rootDir, configPath, config };
}
function system(snapshot: ReturnType<typeof getRuntimePluginSnapshot>) {
  const plugin = snapshot.plugins.find((entry) => entry.id === "system");
  expect(plugin).toBeDefined();
  return plugin!;
}
function otherPlugins(snapshot: ReturnType<typeof getRuntimePluginSnapshot>) {
  return snapshot.plugins.filter((plugin) => plugin.id !== "system");
}
async function readConfig(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("bundled system tools use ordinary plugin management", () => {
  test("the real bundled system plugin is visible and enabled by default", async () => {
    const options = await fixture();
    const before = await readFile(options.configPath, "utf8");
    const snapshot = getRuntimePluginSnapshot(options);
    expect(system(snapshot)).toMatchObject({
      pluginEnabled: true,
      capabilityCount: 7,
      selectedCapabilityCount: 7,
      state: "enabled",
      blockedByGlobalPolicy: false,
    });
    expect(
      system(snapshot)
        .capabilities.map((entry) => entry.id)
        .sort(),
    ).toEqual([
      "computer_act",
      "computer_desktops",
      "computer_observe",
      "system_applications",
      "system_command",
      "system_launch",
      "system_targets",
    ]);
    expect(
      system(snapshot).capabilities.every(
        (entry) => entry.enabled && !entry.blockedByPolicy,
      ),
    ).toBe(true);
    expect(await readFile(options.configPath, "utf8")).toBe(before);
    expect(JSON.stringify(snapshot)).not.toContain("fixture-private-value");
  });

  test("OFF and ON use the same persisted config transaction, backup and restart contract", async () => {
    const options = await fixture();
    const before = getRuntimePluginSnapshot(options);
    const disabled = await setRuntimePluginEnabled(options, {
      pluginId: "system",
      enabled: false,
    });
    expect(system(disabled)).toMatchObject({
      pluginEnabled: false,
      selectedCapabilityCount: 0,
      state: "disabled",
    });
    expect(
      system(disabled).capabilities.every(
        (entry) => !entry.enabled && entry.blockedByPolicy,
      ),
    ).toBe(true);
    expect(disabled).toMatchObject({
      restartRequired: true,
      application: "restart_required",
    });
    expect(disabled.backupPath).toBeTruthy();
    expect(
      await readConfig(join(options.rootDir, disabled.backupPath!)),
    ).toEqual(options.config);
    expect(await readConfig(options.configPath)).toEqual({
      ...options.config,
      plugins: { deny: ["system"] },
    });
    expect(otherPlugins(disabled)).toEqual(otherPlugins(before));
    expect(system(getRuntimePluginSnapshot(options))).toEqual(system(disabled));

    const enabled = await setRuntimePluginEnabled(options, {
      pluginId: "system",
      enabled: true,
    });
    expect(system(enabled)).toMatchObject({
      pluginEnabled: true,
      selectedCapabilityCount: 7,
      state: "enabled",
    });
    expect(otherPlugins(enabled)).toEqual(otherPlugins(before));
    expect(await readConfig(options.configPath)).toEqual({
      ...options.config,
      plugins: { deny: [] },
    });
    expect(JSON.stringify(enabled)).not.toContain("fixture-private-value");
  });

  test("one system capability can be disabled and re-enabled without changing sibling tools", async () => {
    const options = await fixture();
    const before = getRuntimePluginSnapshot(options);
    const disabled = await setRuntimePluginEnabled(options, {
      pluginId: "system",
      capabilityId: "system_command",
      enabled: false,
    });
    expect(system(disabled)).toMatchObject({
      pluginEnabled: true,
      selectedCapabilityCount: 6,
      state: "partial",
    });
    expect(
      system(disabled).capabilities.find(
        (entry) => entry.id === "system_command",
      ),
    ).toMatchObject({ enabled: false, blockedByPolicy: false });
    expect(
      system(disabled)
        .capabilities.filter((entry) => entry.id !== "system_command")
        .every((entry) => entry.enabled),
    ).toBe(true);
    expect((await readConfig(options.configPath)).plugins).toEqual({
      deny: ["system.system_command"],
    });
    expect(otherPlugins(disabled)).toEqual(otherPlugins(before));
    const enabled = await setRuntimePluginEnabled(options, {
      pluginId: "system",
      capabilityId: "system_command",
      enabled: true,
    });
    expect(system(enabled).selectedCapabilityCount).toBe(7);
    expect((await readConfig(options.configPath)).plugins).toEqual({
      deny: [],
    });
  });

  test.each([
    { enabled: false },
    { deny: ["*"] },
    { deny: ["system"] },
    { deny: ["system_command"] },
  ])(
    "capability UI reflects a blocking parent/shared policy and cannot bypass it: %j",
    async (plugins) => {
      const options = await fixture(plugins);
      const before = await readFile(options.configPath, "utf8");
      const snapshot = getRuntimePluginSnapshot(options);
      expect(
        system(snapshot).capabilities.find(
          (entry) => entry.id === "system_command",
        ),
      ).toMatchObject({
        enabled: false,
        blockedByPolicy: true,
        blockedReason: expect.any(String),
      });
      await expect(
        setRuntimePluginEnabled(options, {
          pluginId: "system",
          capabilityId: "system_command",
          enabled: true,
        }),
      ).rejects.toMatchObject({
        code: "plugin_capability_blocked",
        statusCode: 409,
      });
      expect(await readFile(options.configPath, "utf8")).toBe(before);
    },
  );
});
