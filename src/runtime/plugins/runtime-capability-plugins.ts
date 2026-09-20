import type { RuntimeConfig } from "../ports.js";
import type { CompiledRuntimePlugin } from "./compiled-catalog.js";
import {
  loadBundledRuntimePlugins,
  loadConfiguredRuntimePlugins,
} from "./loader.js";

/** Tools and skills share the same selected catalog and compiled instances. */
export function loadRuntimeCapabilityPlugins(
  config?: RuntimeConfig,
): readonly CompiledRuntimePlugin[] {
  return config
    ? loadConfiguredRuntimePlugins(config)
    : loadBundledRuntimePlugins();
}
