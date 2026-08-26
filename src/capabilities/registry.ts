import type {
  RegisteredToolNormalInvocation,
  ToolCallAdapter,
  ToolDefinition,
  ToolImplementation,
  ToolModuleDeclaration,
} from "./tool-types.js";
import { buildToolRegistry } from "./tool-definition-validator.js";

export type ToolRegistryOptions = {
  modules?: readonly ToolModuleDeclaration[];
  disabledTools?: readonly string[];
};

export type ToolRegistryInstance = {
  getDefinitions: () => ToolDefinition[];
  hasToolsAvailable: () => boolean;
  getByName: (name: string) => ToolDefinition | undefined;
  getAdapterByName: (name: string) => ToolCallAdapter | undefined;
  getImplementations: () => Record<string, ToolImplementation>;
  getNormalInvocations: () => readonly RegisteredToolNormalInvocation[];
};

function normalizeDisabledToolNames(
  values: readonly string[] = [],
): Set<string> {
  return new Set(
    values.map((value) => value.trim()).filter((value) => value.length > 0),
  );
}

export function createToolRegistry(
  options: ToolRegistryOptions = {},
): ToolRegistryInstance {
  const disabledTools = normalizeDisabledToolNames(options.disabledTools);
  const registry = buildToolRegistry(options.modules ?? []).filter(
    (tool) => !disabledTools.has(tool.definition.name),
  );
  const normalInvocations = Object.freeze(
    registry.map((tool) =>
      Object.freeze({
        toolName: tool.definition.name,
        definition: tool.definition,
        contract: tool.normalInvocation,
        ...(tool.adapter ? { adapter: tool.adapter } : {}),
      }),
    ),
  );

  return {
    getDefinitions() {
      return registry.map((tool) => tool.definition);
    },
    hasToolsAvailable() {
      return registry.length > 0;
    },
    getByName(name: string) {
      return registry.find((tool) => tool.definition.name === name)?.definition;
    },
    getAdapterByName(name: string) {
      return registry.find((tool) => tool.definition.name === name)?.adapter;
    },
    getImplementations() {
      return Object.fromEntries(
        registry.map((tool) => [tool.definition.name, tool.implementation]),
      );
    },
    getNormalInvocations() {
      return normalInvocations;
    },
  };
}
