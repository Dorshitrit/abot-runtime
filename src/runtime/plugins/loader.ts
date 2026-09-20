import { validateManifestEntrypoint } from "./entrypoint-validation.js";
import { createRequire } from "node:module";
import { join } from "node:path";

import type {
  RuntimePluginEntrypointFactory,
  RuntimePluginLoadContext,
} from "../../plugin-contract/entrypoint.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import type {
  CompiledPluginCapability,
  CompiledRuntimePlugin,
} from "./compiled-catalog.js";
import type { RuntimeConfig } from "../ports.js";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { validateToolModuleDeclarations } from "../../capabilities/tool-definition-validator.js";
import { traceDebug } from "../observability/debug-logger.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import type { DiscoveredAgentPluginManifest } from "./discovered-manifest.js";
import { discoverAgentPluginManifests } from "./manifest-discovery.js";
import { resolveBundledRuntimeRoot } from "./bundled-root.js";
import { projectManifestRuntimeContract } from "./manifest-projection.js";
import { discoverConfiguredRuntimePluginManifests } from "./configured-manifests.js";
import {
  isPluginCatalogDisabled,
  isPluginToolSelected,
  normalizePluginSelection,
  pluginSelectionCacheKey,
} from "./selection.js";

const require = createRequire(import.meta.url);
const compiledCatalogCache = new WeakMap<
  RuntimeConfig,
  Map<string, readonly CompiledRuntimePlugin[]>
>();
const bundledCatalogCache = new Map<string, readonly CompiledRuntimePlugin[]>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unwrapPluginExport(rawModule: unknown): unknown {
  if (
    isRecord(rawModule) &&
    "default" in rawModule &&
    Object.keys(rawModule).length === 1
  ) {
    return rawModule.default;
  }
  return rawModule;
}

function compiledCapabilityFromDeclaration(
  tool: ToolModuleDeclaration,
): CompiledPluginCapability {
  return {
    execute: tool.implementation,
    ...(tool.prepareRequest ? { prepareRequest: tool.prepareRequest } : {}),
    ...(tool.adapter ? { adapter: tool.adapter } : {}),
    definition: tool.definition,
    normalInvocation: tool.normalInvocation,
  };
}

type ManifestRuntimeHostContext = Pick<
  RuntimePluginLoadContext,
  "rootDir" | "runtimeId" | "agentBridgeUrl" | "runtimePaths"
>;

function createManifestSecretAccessor(
  pluginId: string,
  declarations:
    | Readonly<Record<string, Readonly<{ env: string; required: boolean }>>>
    | undefined,
): RuntimePluginLoadContext["secrets"] | undefined {
  if (!declarations || Object.keys(declarations).length === 0) {
    return undefined;
  }
  for (const [name, declaration] of Object.entries(declarations)) {
    if (declaration.required && !nonEmptyString(process.env[declaration.env])) {
      throw new Error(
        `Runtime plugin ${pluginId} requires secret ${name} from environment variable ${declaration.env}`,
      );
    }
  }
  return Object.freeze({
    get(name: string): string | undefined {
      const declaration = declarations[name];
      if (!declaration) {
        throw new Error(
          `Runtime plugin ${pluginId} requested undeclared secret ${name}`,
        );
      }
      const value = process.env[declaration.env];
      return nonEmptyString(value) ? value : undefined;
    },
  });
}

function loadManifestRuntimePlugin(
  host: ManifestRuntimeHostContext,
  discovered: DiscoveredAgentPluginManifest,
  selectedCapabilityIds: readonly string[],
): CompiledRuntimePlugin {
  const manifest = discovered.manifest;
  const extension = manifest.extensions[ABOT_RUNTIME_EXTENSION];
  const capabilityIds = Object.keys(extension.capabilities);
  const projection = projectManifestRuntimeContract(
    discovered,
    selectedCapabilityIds,
  );
  const secrets = createManifestSecretAccessor(
    manifest.name,
    extension.secrets,
  );
  let loaded: unknown;
  try {
    loaded = unwrapPluginExport(require(projection.entryPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load runtime plugin ${manifest.name} from ${projection.entryPath}. The current default loader is synchronous; use a CommonJS .cjs entry. Cause: ${message}`,
    );
  }
  const loadContext = {
    id: manifest.name,
    path: projection.entryPath,
    stateDir: join(host.runtimePaths.runtimeDir, "plugins", manifest.name),
    rootDir: host.rootDir,
    runtimeId: host.runtimeId,
    agentBridgeUrl: host.agentBridgeUrl,
    runtimePaths: host.runtimePaths,
    runtimePathResolver: createRuntimeToolPathResolver(host.runtimePaths),
    pluginRoot: discovered.pluginRoot,
    ...(extension.settings
      ? { config: { ...extension.settings.defaults } }
      : {}),
    ...(secrets ? { secrets } : {}),
  };
  const rawEntrypoint =
    typeof loaded === "function"
      ? (loaded as RuntimePluginEntrypointFactory)(loadContext)
      : loaded;
  const entrypoint = validateManifestEntrypoint({
    pluginId: manifest.name,
    expectedCapabilityIds: capabilityIds,
    raw: rawEntrypoint,
  });
  const declarations: ToolModuleDeclaration[] = projection.capabilities.map(
    ({ definition, normalInvocation }) => ({
      definition,
      normalInvocation,
      implementation: entrypoint.handlers[definition.name]!,
      ...(entrypoint.prepareRequest
        ? { prepareRequest: entrypoint.prepareRequest }
        : {}),
      ...(entrypoint.adapters?.[definition.name]
        ? { adapter: entrypoint.adapters[definition.name] }
        : {}),
    }),
  );

  const tools = validateToolModuleDeclarations(declarations).map(
    compiledCapabilityFromDeclaration,
  );
  traceDebug("runtime.plugins", "manifest_plugin.loaded", {
    pluginId: manifest.name,
    entryPath: projection.entryPath,
    capabilityCount: tools.length,
    operationCount: tools.reduce(
      (count, tool) => count + tool.normalInvocation.operations.length,
      0,
    ),
    skillCount: Object.keys(projection.skills).length,
  });
  return {
    id: manifest.name,
    name: manifest.name,
    ...(manifest.version ? { version: manifest.version } : {}),
    capabilities: tools,
    skills: projection.skills,
    capabilitySkills: projection.capabilitySkills,
  };
}

export function loadConfiguredRuntimePlugins(
  config: RuntimeConfig,
): readonly CompiledRuntimePlugin[] {
  const selection = normalizePluginSelection(config.plugins);
  if (isPluginCatalogDisabled(selection)) {
    return [];
  }
  const cacheKey = pluginSelectionCacheKey(selection);
  const configCache = compiledCatalogCache.get(config);
  const cached = configCache?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const host: ManifestRuntimeHostContext = {
    rootDir: config.paths.rootDir,
    runtimeId: config.runtimeId,
    agentBridgeUrl: config.agentBridgeUrl,
    runtimePaths: config.paths,
  };

  const manifestPlugins = discoverConfiguredRuntimePluginManifests(
    config.paths.rootDir,
    { excludedPluginIds: new Set(selection.deny) },
  )
    .map((plugin) => ({
      plugin,
      selectedCapabilityIds: Object.keys(
        plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities,
      ).filter((capabilityId) =>
        isPluginToolSelected({
          pluginId: plugin.manifest.name,
          toolName: capabilityId,
          selection,
        }),
      ),
    }))
    .filter(({ selectedCapabilityIds }) => selectedCapabilityIds.length > 0)
    .map(({ plugin, selectedCapabilityIds }) =>
      loadManifestRuntimePlugin(host, plugin, selectedCapabilityIds),
    );
  const pluginIds = new Set<string>();
  for (const plugin of manifestPlugins) {
    if (pluginIds.has(plugin.id)) {
      throw new Error(`Duplicate runtime plugin id: ${plugin.id}`);
    }
    pluginIds.add(plugin.id);
  }
  traceDebug("runtime.plugins", "configured_plugins.loaded", {
    manifestPluginCount: manifestPlugins.length,
    pluginIds: [...pluginIds],
  });
  const catalog = Object.freeze(manifestPlugins.map(freezeRuntimePlugin));
  const effectiveCache = configCache ?? new Map();
  effectiveCache.set(cacheKey, catalog);
  if (!configCache) {
    compiledCatalogCache.set(config, effectiveCache);
  }
  return catalog;
}

function createUnconfiguredRuntimePaths(
  rootDir: string,
): RuntimePluginLoadContext["runtimePaths"] {
  const runtimeDir = join(rootDir, ".runtime");
  return {
    rootDir,
    runtimeDir,
    agentWorkDir: rootDir,
    sessionsDir: join(runtimeDir, "sessions"),
    attachmentsDir: join(runtimeDir, "attachments"),
    workspaceDir: join(rootDir, "workspace"),
    sharedDir: join(rootDir, "shared"),
    compiledDir: join(rootDir, "compiled"),
    traceFile: join(rootDir, "logs", "runtime-debug.jsonl"),
  };
}

export function loadBundledRuntimePlugins(): readonly CompiledRuntimePlugin[] {
  const packageRoot = resolveBundledRuntimeRoot();
  const rootDir = process.cwd();
  const cacheKey = `${packageRoot}\0${rootDir}`;
  const cached = bundledCatalogCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const host: ManifestRuntimeHostContext = {
    rootDir,
    runtimeId: "default",
    agentBridgeUrl: "",
    runtimePaths: createUnconfiguredRuntimePaths(rootDir),
  };
  const catalog = Object.freeze(
    discoverAgentPluginManifests(packageRoot).map((plugin) =>
      freezeRuntimePlugin(
        loadManifestRuntimePlugin(
          host,
          plugin,
          Object.keys(
            plugin.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities,
          ),
        ),
      ),
    ),
  );
  bundledCatalogCache.set(cacheKey, catalog);
  return catalog;
}

function freezeRuntimePlugin(
  plugin: CompiledRuntimePlugin,
): CompiledRuntimePlugin {
  return Object.freeze({
    ...plugin,
    capabilities: Object.freeze([...plugin.capabilities]),
    skills: Object.freeze({ ...plugin.skills }),
    capabilitySkills: Object.freeze(
      Object.fromEntries(
        Object.entries(plugin.capabilitySkills).map(
          ([capabilityId, skillNames]) => [
            capabilityId,
            Object.freeze([...skillNames]),
          ],
        ),
      ),
    ),
  });
}

export function runtimePluginsToToolModules(
  plugins: readonly CompiledRuntimePlugin[],
): ToolModuleDeclaration[] {
  return plugins.flatMap((plugin) =>
    plugin.capabilities.map(toolModuleDeclarationFromRuntimePlugin),
  );
}

function toolModuleDeclarationFromRuntimePlugin(
  tool: CompiledPluginCapability,
): ToolModuleDeclaration {
  return {
    implementation: tool.execute,
    ...(tool.prepareRequest ? { prepareRequest: tool.prepareRequest } : {}),
    ...(tool.adapter ? { adapter: tool.adapter } : {}),
    definition: tool.definition,
    normalInvocation: tool.normalInvocation,
  };
}
