import { expect } from "vitest";
import type { ToolRegistry } from "../ports.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";

export const FULL_PLUS_SYSTEM_TOOL_NAMES = Object.freeze([
  "system_applications",
  "system_command",
  "system_launch",
  "system_targets",
]);
export const FULL_PLUS_SYSTEM_OPERATION_IDS = Object.freeze([
  "discover_system_applications",
  "discover_system_targets",
  "launch_system_application",
  "run_system_command",
]);

/** Preserve legacy mode parity and keep FULL+ within the selected inventory. */
export function expectLegacyAndFullPlusInventories(
  source: ToolRegistry,
): ToolRegistry {
  const ask = restrictToolRegistryToRequestMode(source, "ask");
  const full = restrictToolRegistryToRequestMode(source, "full_access");
  const fullPlus = restrictToolRegistryToRequestMode(source, "full_plus");
  expect(ask.listDefinitions()).toEqual(full.listDefinitions());
  expect(ask.listNormalInvocations?.()).toEqual(full.listNormalInvocations?.());
  expect(fullPlus.listDefinitions()).toEqual(source.listDefinitions());
  expect(fullPlus.listNormalInvocations?.()).toEqual(
    source.listNormalInvocations?.(),
  );
  return full;
}
