import { PUBLIC_PLUGIN_CAPABILITY_IDS } from "./public-snapshot/contracts.js";

const runtime = await import("@abot-ai/runtime");
const config = await import("@abot-ai/runtime/runtime/config");
const composition = await import("@abot-ai/runtime/runtime/composition");
const defaultAdapters = await import("@abot-ai/runtime/runtime/default-adapters");
const adapters = await import("@abot-ai/runtime/runtime/adapters");
const ports = await import("@abot-ai/runtime/runtime/ports");
const modelGateway = await import("@abot-ai/runtime/model-gateway");
const pluginSdk = await import("@abot-ai/runtime/plugin-sdk");

const expectations: Array<[string, unknown]> = [
  ["runtime.loadRuntimeConfig", runtime.loadRuntimeConfig],
  ["config.loadRuntimeConfig", config.loadRuntimeConfig],
  [
    "composition.createDefaultRuntimeDependencies",
    composition.createDefaultRuntimeDependencies,
  ],
  [
    "defaultAdapters.createDefaultRuntimeHost",
    defaultAdapters.createDefaultRuntimeHost,
  ],
  ["adapters.createFileSessionStore", adapters.createFileSessionStore],
  ["adapters.createInMemorySessionStore", adapters.createInMemorySessionStore],
  [
    "adapters.createMultiWorkspaceProvider",
    adapters.createMultiWorkspaceProvider,
  ],
  [
    "adapters.createSourceWorkspaceProvider",
    adapters.createSourceWorkspaceProvider,
  ],
  [
    "adapters.createCompiledWorkspaceProvider",
    adapters.createCompiledWorkspaceProvider,
  ],
  [
    "modelGateway.createModelProviderAdapterRegistry",
    modelGateway.createModelProviderAdapterRegistry,
  ],
  [
    "modelGateway.createModelGatewayServer",
    modelGateway.createModelGatewayServer,
  ],
  ["pluginSdk.defineRuntimePlugin", pluginSdk.defineRuntimePlugin],
  ["pluginSdk.resolvePluginPath", pluginSdk.resolvePluginPath],
  ["pluginSdk.successResult", pluginSdk.successResult],
];

for (const [name, value] of expectations) {
  if (typeof value !== "function") {
    throw new Error(`${name} was not exported as a function`);
  }
}

if (Object.keys(ports).length !== 0) {
  throw new Error("runtime/ports should expose type-only exports at runtime");
}

const toolRegistry = defaultAdapters.createDefaultToolRegistry();
const loadedCapabilities = new Set(
  toolRegistry.listDefinitions().map(({ name }) => name),
);
const missingPublicCapabilities = PUBLIC_PLUGIN_CAPABILITY_IDS.filter(
  (capabilityId) => !loadedCapabilities.has(capabilityId),
);
if (missingPublicCapabilities.length > 0) {
  throw new Error(
    `default tool registry did not load every public plugin capability: ${missingPublicCapabilities.join(", ")}`,
  );
}

console.log("runtime package imports ok");
