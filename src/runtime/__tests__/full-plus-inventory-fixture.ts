import { expect } from "vitest";
import type { ToolRegistry } from "../ports.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";

export const FULL_PLUS_SYSTEM_TOOL_NAMES = Object.freeze([
  "computer_act",
  "computer_desktops",
  "computer_observe",
  "system_applications",
  "system_command",
  "system_launch",
  "system_targets",
]);
export const FULL_PLUS_SYSTEM_OPERATION_IDS = Object.freeze([
  "computer_click",
  "computer_drag",
  "computer_focus_window",
  "computer_move",
  "computer_press_keys",
  "computer_scroll",
  "computer_type_text",
  "discover_system_applications",
  "discover_system_targets",
  "inspect_computer_desktops",
  "launch_system_application",
  "observe_computer_desktop",
  "observe_computer_region",
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
