import {
  permitsRequiredToolMode,
  type ToolPermissionMode,
} from "../../capabilities/tool-permission-mode.js";
import type {
  RegisteredToolNormalInvocation,
  ToolDefinition,
} from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";
import {
  captureModelPluginConfig,
  type RuntimeModelPluginConfig,
} from "../config/model-plugin-config.js";
import { matchesToolSelectionId } from "../../shared/tool-selection.js";

/** One lazy registration snapshot; any declared restriction wins across projections. */
export function captureRequestPermissionCatalog(
  registry: ToolRegistry,
  mode: ToolPermissionMode,
  modelPlugins?: RuntimeModelPluginConfig,
) {
  const modelDeniedSelectors = captureModelPluginConfig(modelPlugins)?.deny ?? [];
  const definitions = Object.freeze([...registry.listDefinitions()]);
  const definitionByName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  let registrations: readonly RegisteredToolNormalInvocation[] | undefined;
  let resolvedRegistrations = false;
  const registeredAllowedNames = new Set<string>();
  const registeredDeniedNames = new Set<string>();
  const registeredModelDeniedNames = new Set<string>();
  const isDefinitionBlockedForModel = (definition: ToolDefinition) =>
    modelDeniedSelectors.some((selector) =>
      matchesToolSelectionId(
        definition.pluginName ?? "",
        definition.name,
        selector,
      ),
    );
  const permitsDefinition = (definition: ToolDefinition) => {
    if (isDefinitionBlockedForModel(definition)) return false;
    return permitsRequiredToolMode(mode, definition.requiredPermissionMode);
  };
  const permitsRegistration = (
    registration: RegisteredToolNormalInvocation,
  ) => {
    const definition = definitionByName.get(registration.toolName);
    if (definition && !permitsDefinition(definition)) return false;
    return permitsDefinition(registration.definition);
  };
  function resolveRegistrations():
    | readonly RegisteredToolNormalInvocation[]
    | undefined {
    if (resolvedRegistrations) return registrations;
    const source = registry.listNormalInvocations?.();
    if (source === undefined) {
      resolvedRegistrations = true;
      return undefined;
    }
    for (const registration of source) {
      if (isDefinitionBlockedForModel(registration.definition))
        registeredModelDeniedNames.add(registration.toolName);
      const names = permitsRegistration(registration)
        ? registeredAllowedNames
        : registeredDeniedNames;
      names.add(registration.toolName);
    }
    registrations = Object.freeze(source.filter(permitsRegistration));
    resolvedRegistrations = true;
    return registrations;
  }
  function isRequestToolAvailable(name: string): boolean {
    resolveRegistrations();
    if (registeredDeniedNames.has(name)) return false;
    const definition = definitionByName.get(name);
    if (definition) return permitsDefinition(definition);
    return registeredAllowedNames.has(name);
  }
  function isRequestToolBlockedForModel(name: string): boolean {
    resolveRegistrations();
    if (registeredModelDeniedNames.has(name)) return true;
    const definition = definitionByName.get(name);
    return definition !== undefined && isDefinitionBlockedForModel(definition);
  }
  return Object.freeze({
    isRequestToolBlockedForModel,
    listDefinitions: () =>
      definitions.filter(({ name }) => isRequestToolAvailable(name)),
    listNormalInvocations: resolveRegistrations,
    getDefinition: (name: string) =>
      isRequestToolAvailable(name) ? definitionByName.get(name) : undefined,
    isRequestToolAvailable,
  });
}
