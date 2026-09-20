import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import type { RuntimeConfig, RuntimePluginConfig } from "../ports.js";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import {
  getRuntimePluginSnapshot,
  setRuntimePluginEnabled,
  type RuntimePluginSnapshot,
} from "../../web-ui/plugin-management-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  plugins: RuntimePluginConfig = { allow: ["filesystem", "system-probe"] },
) {
  const rootDir = await mkdtemp(join(tmpdir(), "plugin-capability-controls-"));
  roots.push(rootDir);
  const configPath = join(rootDir, "runtime.config.json");
  const config = {
    models: { providers: { saved: { token: "preserved-test-value" } } },
    plugins,
  };
  await writeFile(configPath, JSON.stringify(config));
  return { rootDir, configPath, config };
}

function capabilityState(snapshot: RuntimePluginSnapshot) {
  return Object.fromEntries(
    snapshot.plugins.flatMap((plugin) =>
      plugin.capabilities.map((capability) => [
        `${plugin.id}.${capability.id}`,
        capability.enabled,
      ]),
    ),
  );
}

function filesystem(snapshot: RuntimePluginSnapshot) {
  return snapshot.plugins.find((plugin) => plugin.id === "filesystem")!;
}

function compiledCapabilityIds(
  rootDir: string,
  plugins: RuntimePluginConfig,
): string[] {
  const config: RuntimeConfig = {
    runtimeId: "plugin-capability-controls",
    agentBridgeUrl: "ws://unused",
    modelGatewayUrl: "http://unused",
    requestRunner: { configPath: join(rootDir, "request-runner.config.json") },
    plugins,
    paths: {
      rootDir,
      runtimeDir: join(rootDir, ".runtime"),
      agentWorkDir: join(rootDir, "agent-work"),
      sessionsDir: join(rootDir, "sessions"),
      attachmentsDir: join(rootDir, "attachments"),
      workspaceDir: join(rootDir, "workspace"),
      sharedDir: join(rootDir, "shared"),
      compiledDir: join(rootDir, "compiled"),
      traceFile: join(rootDir, "trace.jsonl"),
    },
  };
  return loadConfiguredRuntimePlugins(config)
    .flatMap((plugin) =>
      plugin.capabilities.map(
        (capability) => `${plugin.id}.${capability.definition.name}`,
      ),
    )
    .sort();
}

describe("individual plugin capability controls", () => {
  test("disabling read_file preserves every sibling and other plugin, with canonical loader parity", async () => {
    const options = await fixture();
    const before = getRuntimePluginSnapshot(options);
    const expected = {
      ...capabilityState(before),
      "filesystem.read_file": false,
    };
    const result = await setRuntimePluginEnabled(options, {
      pluginId: "filesystem",
      capabilityId: "read_file",
      enabled: false,
    });
    expect(capabilityState(result)).toEqual(expected);
    expect(filesystem(result)).toMatchObject({
      pluginEnabled: true,
      state: "partial",
    });
    expect(result.selection.deny).toEqual(["filesystem.read_file"]);
    const saved = JSON.parse(await readFile(options.configPath, "utf8"));
    expect(saved.models).toEqual(options.config.models);
    expect(compiledCapabilityIds(options.rootDir, saved.plugins)).toEqual(
      Object.entries(expected)
        .filter(([, enabled]) => enabled)
        .map(([id]) => id)
        .sort(),
    );
    const restored = await setRuntimePluginEnabled(options, {
      pluginId: "filesystem",
      capabilityId: "read_file",
      enabled: true,
    });
    expect(capabilityState(restored)).toEqual(capabilityState(before));
    expect(filesystem(restored).pluginEnabled).toBe(true);
  });

  test("concurrent capability saves through aliases preserve both selections", async () => {
    const options = await fixture();
    const aliasPath = join(options.rootDir, "config-alias.json");
    await symlink(options.configPath, aliasPath);
    const before = capabilityState(getRuntimePluginSnapshot(options));
    await Promise.all([
      setRuntimePluginEnabled(options, {
        pluginId: "filesystem",
        capabilityId: "read_file",
        enabled: false,
      }),
      setRuntimePluginEnabled(
        { ...options, configPath: aliasPath },
        {
          pluginId: "filesystem",
          capabilityId: "write_file",
          enabled: false,
        },
      ),
    ]);
    const snapshot = getRuntimePluginSnapshot(options);
    expect(snapshot.selection.deny).toEqual([
      "filesystem.read_file",
      "filesystem.write_file",
    ]);
    expect(capabilityState(snapshot)).toEqual({
      ...before,
      "filesystem.read_file": false,
      "filesystem.write_file": false,
    });
    expect(await readFile(aliasPath, "utf8")).toBe(
      await readFile(options.configPath, "utf8"),
    );
  });

  test("a failed capability update releases its config lock for another update", async () => {
    const options = await fixture();
    const outcomes = await Promise.allSettled([
      setRuntimePluginEnabled(options, {
        pluginId: "filesystem",
        capabilityId: "not_declared",
        enabled: false,
      }),
      setRuntimePluginEnabled(options, {
        pluginId: "filesystem",
        capabilityId: "read_file",
        enabled: false,
      }),
    ]);
    expect(outcomes[0]).toMatchObject({
      status: "rejected",
      reason: { code: "plugin_capability_not_found" },
    });
    expect(outcomes[1].status).toBe("fulfilled");
    expect(getRuntimePluginSnapshot(options).selection.deny).toEqual([
      "filesystem.read_file",
    ]);
  });

  test("restrictive allow is expanded by exactly one qualified capability", async () => {
    const options = await fixture({
      allow: ["system-probe"],
      deny: ["unrelated_rule"],
    });
    const before = getRuntimePluginSnapshot(options);
    expect(filesystem(before)).toMatchObject({
      pluginEnabled: true,
      state: "disabled",
    });
    const result = await setRuntimePluginEnabled(options, {
      pluginId: "filesystem",
      capabilityId: "read_file",
      enabled: true,
    });
    expect(capabilityState(result)).toEqual({
      ...capabilityState(before),
      "filesystem.read_file": true,
    });
    expect(result.selection.allow).toEqual([
      "filesystem.read_file",
      "system-probe",
    ]);
    expect(result.selection.deny).toEqual(["unrelated_rule"]);
    const saved = JSON.parse(await readFile(options.configPath, "utf8"));
    expect(compiledCapabilityIds(options.rootDir, saved.plugins)).toEqual([
      "filesystem.read_file",
      "system-probe.system_probe",
    ]);
  });

  test("all children may be disabled while the parent remains enabled and a child can be restored", async () => {
    const options = await fixture();
    const ids = filesystem(getRuntimePluginSnapshot(options)).capabilities.map(
      (capability) => capability.id,
    );
    await writeFile(
      options.configPath,
      JSON.stringify({
        ...options.config,
        plugins: {
          allow: ["filesystem"],
          deny: ids.map((id) => `filesystem.${id}`),
        },
      }),
    );
    const before = filesystem(getRuntimePluginSnapshot(options));
    expect(before).toMatchObject({
      pluginEnabled: true,
      state: "disabled",
      selectedCapabilityCount: 0,
    });
    expect(
      before.capabilities.every((capability) => !capability.blockedByPolicy),
    ).toBe(true);
    const result = await setRuntimePluginEnabled(options, {
      pluginId: "filesystem",
      capabilityId: "read_file",
      enabled: true,
    });
    expect(filesystem(result)).toMatchObject({
      pluginEnabled: true,
      state: "partial",
      selectedCapabilityCount: 1,
    });
  });

  test.each([
    { enabled: false, allow: ["*"] },
    { allow: ["*"], deny: ["*"] },
    { allow: ["*"], deny: ["filesystem"] },
    { allow: ["*"], deny: ["read_file", "filesystem.read_file"] },
  ])(
    "broad policy remains explicit and blocked updates do not write: %j",
    async (selection) => {
      const options = await fixture(selection);
      const before = await readFile(options.configPath, "utf8");
      const capability = filesystem(
        getRuntimePluginSnapshot(options),
      ).capabilities.find((entry) => entry.id === "read_file")!;
      expect(capability).toMatchObject({
        enabled: false,
        blockedByPolicy: true,
      });
      expect(capability.blockedReason).toEqual(expect.any(String));
      await expect(
        setRuntimePluginEnabled(options, {
          pluginId: "filesystem",
          capabilityId: "read_file",
          enabled: true,
        }),
      ).rejects.toMatchObject({
        code: "plugin_capability_blocked",
        statusCode: 409,
      });
      expect(await readFile(options.configPath, "utf8")).toBe(before);
      expect(
        (await readdir(options.rootDir)).filter((name) =>
          name.endsWith(".bak"),
        ),
      ).toEqual([]);
    },
  );

  test.each(["system_probe", "*", "__proto__"])(
    "rejects capability outside exact manifest membership: %s",
    async (capabilityId) => {
      const options = await fixture();
      const before = await readFile(options.configPath, "utf8");
      await expect(
        setRuntimePluginEnabled(options, {
          pluginId: "filesystem",
          capabilityId,
          enabled: false,
        }),
      ).rejects.toMatchObject({ code: "plugin_capability_not_found" });
      expect(await readFile(options.configPath, "utf8")).toBe(before);
    },
  );

  test("qualified selectors cannot alias an already disabled sibling", async () => {
    const options = await fixture({
      allow: ["selection-collision"],
      deny: ["selection-collision.selection-collision.x"],
    });
    const manifest = JSON.parse(
      await readFile(
        join(process.cwd(), "plugins", "system-probe", "plugin.json"),
        "utf8",
      ),
    );
    manifest.name = "selection-collision";
    const extension = manifest.extensions[ABOT_RUNTIME_EXTENSION];
    const capability = Object.values(extension.capabilities)[0];
    extension.capabilities = {
      x: capability,
      "selection-collision.x": capability,
    };
    const directory = join(options.rootDir, "plugins", manifest.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
    const before = await readFile(options.configPath, "utf8");
    const snapshot = getRuntimePluginSnapshot(options);
    expect(
      snapshot.plugins.find((plugin) => plugin.id === manifest.name),
    ).toMatchObject({ selectedCapabilityCount: 1 });
    await expect(
      setRuntimePluginEnabled(options, {
        pluginId: manifest.name,
        capabilityId: "x",
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "plugin_selection_conflict" });
    expect(await readFile(options.configPath, "utf8")).toBe(before);
  });

  test("whole plugin updates reject ID collisions that would change another plugin", async () => {
    const options = await fixture({ allow: ["*"] });
    const manifest = JSON.parse(
      await readFile(
        join(process.cwd(), "plugins", "system-probe", "plugin.json"),
        "utf8",
      ),
    );
    manifest.name = "selection-collision";
    const extension = manifest.extensions[ABOT_RUNTIME_EXTENSION];
    extension.capabilities = {
      filesystem: Object.values(extension.capabilities)[0],
    };
    const directory = join(options.rootDir, "plugins", manifest.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
    const before = await readFile(options.configPath, "utf8");
    await expect(
      setRuntimePluginEnabled(options, {
        pluginId: "filesystem",
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "plugin_selection_conflict" });
    expect(await readFile(options.configPath, "utf8")).toBe(before);
  });
});
