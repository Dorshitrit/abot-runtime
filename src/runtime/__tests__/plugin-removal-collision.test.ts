import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { removeRuntimePlugin } from "../../web-ui/plugin-removal-service.js";
import {
  getRuntimePluginSnapshot,
  setRuntimePluginEnabled,
} from "../../web-ui/plugin-management-service.js";
import {
  normalizePluginSelection,
  isPluginToolSelected,
} from "../plugins/selection.js";
import {
  inspectPluginPackage,
  installPluginPackage,
} from "../plugins/installation/service.js";
import { installedRemovalFixture } from "./support/plugin-removal-fixture.js";
import {
  communityManifest,
  communityArchive,
  pluginSource,
  sourceFetcher,
} from "./support/plugin-installation-fixture.js";

async function neighbor(root: string, id: string, capability: string) {
  const directory = join(root, "plugins", id);
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(
    join(directory, "plugin.json"),
    JSON.stringify(communityManifest(id, capability)),
  );
  await writeFile(join(directory, "src/index.cjs"), "module.exports = {};");
  return directory;
}

test.each([
  { composite: false, collidingDeny: false, restrictedAllow: false },
  { composite: true, collidingDeny: false, restrictedAllow: false },
  { composite: false, collidingDeny: true, restrictedAllow: false },
  { composite: true, collidingDeny: true, restrictedAllow: false },
  { composite: true, collidingDeny: false, restrictedAllow: true },
  { composite: true, collidingDeny: true, restrictedAllow: true },
])(
  "Remove and reinstall preserve selection policy across collisions: %j",
  async ({ composite, collidingDeny, restrictedAllow }) => {
    const manifest = communityManifest("community-example", "ping");
    manifest.extensions["ai.abot.runtime"].capabilities.kept =
      manifest.extensions["ai.abot.runtime"].capabilities.ping;
    const archive = await communityArchive({ manifest });
    const f = await installedRemovalFixture(archive);
    const directory = await neighbor(f.rootDir, "neighbor", f.input.pluginId);
    if (composite) {
      await neighbor(f.rootDir, "community-example.ping", "separate");
      await neighbor(f.rootDir, "ping", "another");
      await neighbor(f.rootDir, "dot-neighbor", "community-example.ping");
    }
    const policy = {
      ...(restrictedAllow ? { allow: ["neighbor"] } : {}),
      deny: [
        "community-example.kept",
        "unrelated_rule",
        ...(collidingDeny ? [" community-example "] : []),
      ],
      disabledPluginIds: ["unrelated-plugin"],
    };
    await writeFile(f.configPath, JSON.stringify({ plugins: policy }));
    const before = getRuntimePluginSnapshot(f);
    const runtime = {
      ...f,
      applyConfiguration: async () => {
        const selection = normalizePluginSelection(await f.selection());
        expect(
          isPluginToolSelected({
            pluginId: f.input.pluginId,
            toolName: "ping",
            selection,
          }),
        ).toBe(false);
        expect(
          isPluginToolSelected({
            pluginId: "neighbor",
            toolName: f.input.pluginId,
            selection,
          }),
        ).toBe(!collidingDeny);
        return { status: "ready" as const };
      },
    };
    const result = await removeRuntimePlugin(runtime, f.input);
    expect(result.removed).toBe(true);
    expect(existsSync(f.path)).toBe(false);
    expect(await readFile(join(directory, "src/index.cjs"), "utf8")).toBe(
      "module.exports = {};",
    );
    expect(result.plugins).toEqual(
      before.plugins.filter((p) => p.id !== f.input.pluginId),
    );
    expect(await f.selection()).toEqual({
      ...policy,
      disabledPluginIds: ["unrelated-plugin", f.input.pluginId],
    });

    const download = sourceFetcher(archive);
    const review = await inspectPluginPackage(
      f.rootDir,
      pluginSource,
      download,
    );
    const reinstalled = await installPluginPackage({
      rootDir: f.rootDir,
      configPath: f.configPath,
      download,
      input: { source: review.source, digest: review.digest },
      saveSelection: (pluginId, transaction) =>
        setRuntimePluginEnabled(f, { pluginId, enabled: true }, transaction),
    });
    expect(existsSync(f.path)).toBe(true);
    expect(await f.selection()).toEqual(policy);
    expect(reinstalled.snapshot.plugins).toEqual(before.plugins);
    const targetRestrictedByPolicy = collidingDeny || restrictedAllow;
    expect(
      reinstalled.snapshot.plugins.find((p) => p.id === f.input.pluginId),
    ).toMatchObject({
      state: targetRestrictedByPolicy ? "disabled" : "partial",
      pluginEnabled: !collidingDeny,
      selectedCapabilityCount: targetRestrictedByPolicy ? 0 : 1,
    });
    // The same root remains removable after reinstall; no generated tool deny accumulates.
    expect((await removeRuntimePlugin(runtime, f.input)).removed).toBe(true);
    expect((await f.selection()).deny).toEqual(policy.deny);
  },
);
