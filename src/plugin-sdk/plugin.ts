import type {
  RuntimePluginEntrypoint,
  RuntimePluginEntrypointFactory,
} from "../plugin-contract/entrypoint.js";

export type RuntimePluginDefinition =
  | RuntimePluginEntrypoint
  | RuntimePluginEntrypointFactory;

/**
 * Declares a runtime plugin while preserving its exact factory or entrypoint
 * type. Runtime validation remains owned by the manifest loader.
 */
export function defineRuntimePlugin<const T extends RuntimePluginDefinition>(
  definition: T,
): T {
  return definition;
}
