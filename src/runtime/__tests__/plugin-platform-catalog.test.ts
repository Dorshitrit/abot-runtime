import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentPluginManifest } from "../../plugin-contract/manifest.js";
import { ABOT_PLUGIN_COMPATIBILITY_EXTENSION } from "../../plugin-contract/platform-compatibility.js";
import type { PluginRuntimePlatform } from "../../plugin-contract/platform-compatibility.js";
import { projectPluginSnapshot } from "../../web-ui/plugin-management-catalog.js";

function catalogManifest(runtimePlatforms?: readonly PluginRuntimePlatform[]) {
  const pluginRoot = join(process.cwd(), "plugins", "system-probe");
  const manifestPath = join(pluginRoot, "plugin.json");
  const source = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete source.extensions[ABOT_PLUGIN_COMPATIBILITY_EXTENSION];
  if (runtimePlatforms) {
    source.extensions[ABOT_PLUGIN_COMPATIBILITY_EXTENSION] = {
      version: 1,
      runtimePlatforms,
    };
  }
  return { pluginRoot, manifestPath, manifest: source as AgentPluginManifest };
}

describe("plugin catalog host compatibility", () => {
  test.each<NodeJS.Platform>(["linux", "darwin", "win32"])(
    "projects host compatibility separately from saved selection on %s",
    (runtimePlatform) => {
      const manifest = catalogManifest(["linux"]);
      const config = { enabled: true, allow: ["*"], deny: [] };
      const original = structuredClone(config);
      const baseline = projectPluginSnapshot(
        [manifest],
        config,
        undefined,
        "linux",
      );
      const projected = projectPluginSnapshot(
        [manifest],
        config,
        undefined,
        runtimePlatform,
      );
      const { compatibility, ...selection } = projected.plugins[0]!;
      const { compatibility: _baselineCompatibility, ...baselineSelection } =
        baseline.plugins[0]!;
      expect(selection).toEqual(baselineSelection);
      expect(selection.pluginEnabled).toBe(true);
      expect(selection.state).toBe("enabled");
      expect(
        selection.capabilities.every((capability) => capability.enabled),
      ).toBe(true);
      expect(compatibility).toMatchObject({
        supported: runtimePlatform === "linux",
        status: runtimePlatform === "linux" ? "declared" : "unsupported",
        runtimePlatform,
        runtimePlatforms: ["linux"],
      });
      expect(projected.selection).toEqual(baseline.selection);
      expect(config).toEqual(original);
    },
  );

  test("preserves a disabled selection independently of undeclared Windows support", () => {
    const manifest = catalogManifest();
    const snapshot = projectPluginSnapshot(
      [manifest],
      { deny: [manifest.manifest.name] },
      undefined,
      "win32",
    );
    expect(snapshot.plugins[0]).toMatchObject({
      pluginEnabled: false,
      state: "disabled",
      selectedCapabilityCount: 0,
      compatibility: {
        supported: false,
        status: "undeclared",
        runtimePlatform: "win32",
      },
    });
  });
});
