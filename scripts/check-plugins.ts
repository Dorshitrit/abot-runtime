import { resolveBundledRuntimeRoot } from "../src/runtime/plugins/bundled-root.js";
import { ABOT_RUNTIME_EXTENSION } from "../src/plugin-contract/manifest.js";
import { discoverAgentPluginManifests } from "../src/runtime/plugins/manifest-discovery.js";
import { projectManifestRuntimeContract } from "../src/runtime/plugins/manifest-projection.js";

const plugins = discoverAgentPluginManifests(resolveBundledRuntimeRoot()).map(
  (plugin) => ({
    plugin,
    projection: projectManifestRuntimeContract(
      plugin,
      Object.keys(
        plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities,
      ),
    ),
  }),
);
if (plugins.length === 0) {
  throw new Error("No runtime plugin manifests were discovered");
}

const capabilityCount = plugins.reduce(
  (count, { projection }) => count + projection.capabilities.length,
  0,
);
const operationCount = plugins.reduce(
  (count, plugin) =>
    count +
    plugin.projection.capabilities.reduce(
      (pluginCount, capability) =>
        pluginCount + capability.normalInvocation.operations.length,
      0,
    ),
  0,
);
const catalogGroups = [
  ...new Set(
    plugins.flatMap(({ projection }) =>
      projection.capabilities.flatMap(
        ({ definition }) => definition.catalogGroups ?? [],
      ),
    ),
  ),
].sort();
const catalogGroupOperationCounts = Object.fromEntries(
  catalogGroups.map((catalogGroup) => [
    catalogGroup,
    plugins.reduce(
      (count, plugin) =>
        count +
        plugin.projection.capabilities.reduce(
          (pluginCount, capability) =>
            pluginCount +
            (capability.definition.catalogGroups?.includes(catalogGroup)
              ? capability.normalInvocation.operations.length
              : 0),
          0,
        ),
      0,
    ),
  ]),
);

console.log(
  `runtime plugins ok: ${plugins.length} plugins, ${capabilityCount} capabilities, ${operationCount} operations, groups=${JSON.stringify(catalogGroupOperationCounts)}`,
);
