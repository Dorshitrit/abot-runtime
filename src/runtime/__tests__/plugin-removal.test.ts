import { existsSync } from "node:fs";
import { readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  getRuntimePluginSnapshot,
  PluginManagementError,
  setRuntimePluginEnabled,
} from "../../web-ui/plugin-management-service.js";
import { removeRuntimePlugin } from "../../web-ui/plugin-removal-service.js";
import { pluginSource } from "./support/plugin-installation-fixture.js";
import { installedRemovalFixture } from "./support/plugin-removal-fixture.js";

test("removes the installer-owned directory only after disable and activation, preserving unrelated policy", async () => {
  const f = await installedRemovalFixture();
  const before = getRuntimePluginSnapshot(f);
  expect(before.plugins.find((p) => p.id === f.input.pluginId)?.removable).toBe(
    true,
  );
  expect(before.plugins.find((p) => p.id === "system-probe")?.removable).toBe(
    false,
  );
  const result = await removeRuntimePlugin(f, f.input);
  expect(result.removed).toBe(true);
  expect(f.requireInactive).toHaveBeenCalledWith(f.input.pluginId, [
    "community_ping",
  ]);
  expect(existsSync(f.path)).toBe(false);
  expect(result.plugins.some((p) => p.id === f.input.pluginId)).toBe(false);
  expect(await f.selection()).toEqual({
    allow: ["community-example"],
    disabledPluginIds: ["community-example"],
  });
  expect(result.plugins.filter((p) => p.id !== f.input.pluginId)).toEqual(
    before.plugins.filter((p) => p.id !== f.input.pluginId),
  );
});

test("busy owner leaves files installed and disabled; a later Remove completes when idle", async () => {
  const f = await installedRemovalFixture();
  const busy = await removeRuntimePlugin(
    {
      ...f,
      applyConfiguration: async () => ({
        status: "restart_required",
        message: "Runtime is busy.",
      }),
    },
    f.input,
  );
  expect(busy).toMatchObject({
    removed: false,
    message: expect.stringContaining("Remove again"),
  });
  expect(existsSync(f.path)).toBe(true);
  expect(f.requireInactive).not.toHaveBeenCalled();
  expect((await f.selection()).disabledPluginIds).toContain(f.input.pluginId);
  expect((await removeRuntimePlugin(f, f.input)).removed).toBe(true);
});

test("failed activation retains the complete package for retry", async () => {
  const f = await installedRemovalFixture();
  const original = await readFile(join(f.path, "src/index.cjs"), "utf8");
  await expect(
    removeRuntimePlugin(
      {
        ...f,
        applyConfiguration: async () => {
          throw new Error("activation failed");
        },
      },
      f.input,
    ),
  ).rejects.toThrow("activation failed");
  expect(await readFile(join(f.path, "src/index.cjs"), "utf8")).toBe(original);
  expect(f.requireInactive).not.toHaveBeenCalled();
});

test("a concurrent re-enable between Apply and removal prevents deletion", async () => {
  const f = await installedRemovalFixture();
  await expect(
    removeRuntimePlugin(
      {
        ...f,
        applyConfiguration: async () => {
          await setRuntimePluginEnabled(f, { ...f.input, enabled: true });
          return { status: "ready" };
        },
      },
      f.input,
    ),
  ).rejects.toMatchObject({ code: "config_changed" });
  expect(existsSync(f.path)).toBe(true);
});

test("loaded owner state is checked even when saved configuration is disabled", async () => {
  const f = await installedRemovalFixture();
  await expect(
    removeRuntimePlugin(
      {
        ...f,
        requireInactive: () => {
          throw new PluginManagementError(
            "plugin_still_active",
            "still active",
            409,
          );
        },
      },
      f.input,
    ),
  ).rejects.toThrow("still active");
  expect(existsSync(f.path)).toBe(true);
});

test("replacement package after Apply is not deleted", async () => {
  const f = await installedRemovalFixture();
  await expect(
    removeRuntimePlugin(
      {
        ...f,
        applyConfiguration: async () => {
          await writeFile(
            join(f.path, ".abot-install.json"),
            JSON.stringify({
              schemaVersion: 1,
              source: pluginSource,
              digest: "f".repeat(64),
              installedAt: new Date().toISOString(),
            }),
          );
          return { status: "ready" };
        },
      },
      f.input,
    ),
  ).rejects.toMatchObject({ code: "plugin_changed" });
  expect(existsSync(f.path)).toBe(true);
});

test.each(["receipt", "folder", "parent"])(
  "a symlink in the %s cannot authorize removal",
  async (kind) => {
    const f = await installedRemovalFixture();
    const target =
      kind === "receipt"
        ? join(f.path, ".abot-install.json")
        : kind === "folder"
          ? f.path
          : join(f.rootDir, "plugins");
    const outside = join(f.rootDir, "retained");
    await rename(target, outside);
    await symlink(outside, target, kind === "receipt" ? "file" : "dir");
    await expect(removeRuntimePlugin(f, f.input)).rejects.toThrow(
      kind === "folder"
        ? "resolves outside rootDir/plugins"
        : "Only plugins installed from GitHub",
    );
    expect(existsSync(outside)).toBe(true);
    expect(f.applyConfiguration).not.toHaveBeenCalled();
  },
);

test.each(["system-probe", "../plugins", "missing"])(
  "built-in or unknown target %s is never removed",
  async (pluginId) => {
    const f = await installedRemovalFixture();
    await expect(removeRuntimePlugin(f, { pluginId })).rejects.toMatchObject({
      code: "plugin_not_removable",
    });
    expect(f.applyConfiguration).not.toHaveBeenCalled();
  },
);
