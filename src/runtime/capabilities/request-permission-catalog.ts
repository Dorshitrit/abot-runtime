import {
  permitsRequiredToolMode,
  type ToolPermissionMode,
} from "../../capabilities/tool-permission-mode.js";
import type {
  RegisteredToolNormalInvocation,
  ToolDefinition,
} from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";

/** One lazy registration snapshot; any declared restriction wins across projections. */
export function captureRequestPermissionCatalog(
  registry: ToolRegistry,
  mode: ToolPermissionMode,
) {
  const definitions = Object.freeze([...registry.listDefinitions()]);
  const definitionByName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  let registrations: readonly RegisteredToolNormalInvocation[] | undefined;
  let resolvedRegistrations = false;
  const registeredAllowedNames = new Set<string>();
  const registeredDeniedNames = new Set<string>();
  const permitsDefinition = (definition: ToolDefinition) =>
    permitsRequiredToolMode(mode, definition.requiredPermissionMode);
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
  return Object.freeze({
    listDefinitions: () =>
      definitions.filter(({ name }) => isRequestToolAvailable(name)),
    listNormalInvocations: resolveRegistrations,
    getDefinition: (name: string) =>
      isRequestToolAvailable(name) ? definitionByName.get(name) : undefined,
    isRequestToolAvailable,
  });
}
