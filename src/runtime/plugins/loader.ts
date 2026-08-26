import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import type {
  RuntimePluginEntrypoint,
  RuntimePluginEntrypointFactory,
  RuntimePluginLoadContext,
} from "../../plugin-contract/entrypoint.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import type {
  CompiledPluginCapability,
  CompiledRuntimePlugin,
} from "./compiled-catalog.js";
import type { RuntimeConfig, RuntimePluginConfig } from "../ports.js";
import type {
  ToolCallAdapter,
  ToolImplementation,
  ToolModuleDeclaration,
} from "../../capabilities/tool-types.js";
import { validateToolModuleDeclarations } from "../../capabilities/tool-definition-validator.js";
import { traceDebug } from "../observability/debug-logger.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import type { DiscoveredAgentPluginManifest } from "./discovered-manifest.js";
import { discoverAgentPluginManifests } from "./manifest-discovery.js";
import { resolveBundledRuntimeRoot } from "./bundled-root.js";
import { projectManifestRuntimeContract } from "./manifest-projection.js";

const require = createRequire(import.meta.url);
const compiledCatalogCache = new WeakMap<
  RuntimeConfig,
  Map<string, readonly CompiledRuntimePlugin[]>
>();
const bundledCatalogCache = new Map<string, readonly CompiledRuntimePlugin[]>();

type PluginSelection = Readonly<{
  enabled: boolean;
  allow: readonly string[];
  deny: readonly string[];
}>;

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizePluginSelection(
  config: RuntimePluginConfig | undefined,
): PluginSelection {
  return Object.freeze({
    enabled: config?.enabled !== false,
    allow: Object.freeze(uniqueSorted(config?.allow)),
    deny: Object.freeze(uniqueSorted(config?.deny)),
  });
}

function pluginSelectionCacheKey(selection: PluginSelection): string {
  return JSON.stringify([selection.enabled, selection.allow, selection.deny]);
}

function matchesPluginToolId(
  pluginId: string,
  toolName: string,
  configuredId: string,
): boolean {
  return (
    configuredId === "*" ||
    configuredId === pluginId ||
    configuredId === toolName ||
    configuredId === `${pluginId}.${toolName}`
  );
}

function isPluginToolSelected(params: {
  pluginId: string;
  toolName: string;
  selection: PluginSelection;
}): boolean {
  if (!params.selection.enabled) {
    return false;
  }
  if (
    params.selection.allow.length > 0 &&
    !params.selection.allow.some((entry) =>
      matchesPluginToolId(params.pluginId, params.toolName, entry),
    )
  ) {
    return false;
  }
  return !params.selection.deny.some((entry) =>
    matchesPluginToolId(params.pluginId, params.toolName, entry),
  );
}

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
    ...(tool.adapter ? { adapter: tool.adapter } : {}),
    definition: tool.definition,
    normalInvocation: tool.normalInvocation,
  };
}

function validateManifestEntrypoint(params: {
  pluginId: string;
  expectedCapabilityIds: readonly string[];
  raw: unknown;
}): RuntimePluginEntrypoint {
  if (!isRecord(params.raw) || !isRecord(params.raw.handlers)) {
    throw new Error(
      `Runtime plugin ${params.pluginId} entrypoint must export handlers`,
    );
  }
  const unexpectedEntrypointKeys = Object.keys(params.raw).filter(
    (key) => key !== "handlers" && key !== "adapters",
  );
  if (unexpectedEntrypointKeys.length > 0) {
    throw new Error(
      `Runtime plugin ${params.pluginId} entrypoint contains unsupported field ${unexpectedEntrypointKeys[0]}`,
    );
  }
  const handlers: Record<string, ToolImplementation> = {};
  for (const [capabilityId, handler] of Object.entries(params.raw.handlers)) {
    if (typeof handler !== "function") {
      throw new Error(
        `Runtime plugin ${params.pluginId} handler ${capabilityId} must be a function`,
      );
    }
    handlers[capabilityId] = handler as ToolImplementation;
  }
  const expected = new Set(params.expectedCapabilityIds);
  const missing = params.expectedCapabilityIds.filter(
    (capabilityId) => !handlers[capabilityId],
  );
  const unexpected = Object.keys(handlers).filter(
    (capabilityId) => !expected.has(capabilityId),
  );
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Runtime plugin ${params.pluginId} handler mismatch: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    );
  }
  const adapters: Record<string, ToolCallAdapter> = {};
  if (params.raw.adapters !== undefined) {
    if (!isRecord(params.raw.adapters)) {
      throw new Error(
        `Runtime plugin ${params.pluginId} entrypoint adapters must be an object`,
      );
    }
    for (const [capabilityId, rawAdapter] of Object.entries(
      params.raw.adapters,
    )) {
      if (!expected.has(capabilityId)) {
        throw new Error(
          `Runtime plugin ${params.pluginId} adapter ${capabilityId} has no declared capability`,
        );
      }
      if (!isRecord(rawAdapter)) {
        throw new Error(
          `Runtime plugin ${params.pluginId} adapter ${capabilityId} must be an object`,
        );
      }
      const unexpectedAdapterKeys = Object.keys(rawAdapter).filter(
        (key) => key !== "normalizeCall" && key !== "validateCall",
      );
      if (unexpectedAdapterKeys.length > 0) {
        throw new Error(
          `Runtime plugin ${params.pluginId} adapter ${capabilityId} contains unsupported field ${unexpectedAdapterKeys[0]}`,
        );
      }
      if (
        rawAdapter.normalizeCall !== undefined &&
        typeof rawAdapter.normalizeCall !== "function"
      ) {
        throw new Error(
          `Runtime plugin ${params.pluginId} adapter ${capabilityId}.normalizeCall must be a function`,
        );
      }
      if (
        rawAdapter.validateCall !== undefined &&
        typeof rawAdapter.validateCall !== "function"
      ) {
        throw new Error(
          `Runtime plugin ${params.pluginId} adapter ${capabilityId}.validateCall must be a function`,
        );
      }
      adapters[capabilityId] = rawAdapter as ToolCallAdapter;
    }
  }
  return {
    handlers,
    ...(Object.keys(adapters).length > 0 ? { adapters } : {}),
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

function discoverConfiguredRuntimePluginManifests(
  consumerRoot: string,
): readonly DiscoveredAgentPluginManifest[] {
  const bundledRoot = resolveBundledRuntimeRoot();
  const roots =
    canonicalPluginDiscoveryRoot(bundledRoot) ===
    canonicalPluginDiscoveryRoot(consumerRoot)
      ? [consumerRoot]
      : [bundledRoot, consumerRoot];
  const plugins = roots.flatMap((rootDir) =>
    discoverAgentPluginManifests(rootDir),
  );
  assertUniquePluginManifestIds(plugins);
  return Object.freeze(plugins);
}

export function loadConfiguredRuntimePlugins(
  config: RuntimeConfig,
): readonly CompiledRuntimePlugin[] {
  const selection = normalizePluginSelection(config.plugins);
  if (!selection.enabled) {
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
    ...(tool.adapter ? { adapter: tool.adapter } : {}),
    definition: tool.definition,
    normalInvocation: tool.normalInvocation,
  };
}
