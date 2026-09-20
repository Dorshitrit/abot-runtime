import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { DiscoveredAgentPluginManifest } from "./discovered-manifest.js";
import {
  discoverAgentPluginManifests,
  type AgentPluginManifestDiscoveryOptions,
} from "./manifest-discovery.js";
import { resolveBundledRuntimeRoot } from "./bundled-root.js";

function canonicalPluginDiscoveryRoot(rootDir: string): string {
  const absoluteRoot = resolve(rootDir);
  try {
    return realpathSync(absoluteRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return absoluteRoot;
  }
}

function assertUniquePluginManifestIds(
  plugins: readonly DiscoveredAgentPluginManifest[],
): void {
  const manifestPathsByPluginId = new Map<string, string>();
  for (const plugin of plugins) {
    const pluginId = plugin.manifest.name;
    const previousManifestPath = manifestPathsByPluginId.get(pluginId);
    if (previousManifestPath) {
      throw new Error(
        `Duplicate runtime plugin id: ${pluginId}; manifests: ${previousManifestPath}, ${plugin.manifestPath}`,
      );
    }
    manifestPathsByPluginId.set(pluginId, plugin.manifestPath);
  }
}

export function discoverConfiguredRuntimePluginManifests(
  consumerRoot: string,
  options: AgentPluginManifestDiscoveryOptions = {},
): readonly DiscoveredAgentPluginManifest[] {
  const bundledRoot = resolveBundledRuntimeRoot();
  const roots =
    canonicalPluginDiscoveryRoot(bundledRoot) ===
    canonicalPluginDiscoveryRoot(consumerRoot)
      ? [consumerRoot]
      : [bundledRoot, consumerRoot];
  const plugins = roots.flatMap((rootDir) =>
    discoverAgentPluginManifests(rootDir, options),
  );
  assertUniquePluginManifestIds(plugins);
  return Object.freeze(plugins);
}
