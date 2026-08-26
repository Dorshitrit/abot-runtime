import type {
  RoleCallFrame,
  RoleCallPlanBinding,
} from "../../role-calls/index.js";

export function workerCapabilityScopeDiagnosticFields(
  scope: RoleCallFrame["workerCapabilityScope"],
): Record<string, unknown> {
  return scope
    ? {
        workerCapabilityCatalogGroupIds: scope.catalogGroupIds,
        workerCapabilityCatalogGroupCount: scope.catalogGroupIds.length,
      }
    : { workerCapabilityCatalogGroupCount: 0 };
}

export function workingDirectoryDiagnosticFields(
  workingDirectory: string | undefined,
): Record<string, unknown> {
  return {
    workingDirectoryIncluded: workingDirectory !== undefined,
    workingDirectoryLength: workingDirectory?.length ?? 0,
  };
}

export function planBindingDiagnosticFields(
  binding: RoleCallPlanBinding | undefined,
): Record<string, unknown> {
  if (!binding) return { planBindingMode: "none" };
  if (binding.mode === "select") {
    return {
      planBindingMode: "select",
      selectedPlanItemIds: binding.itemIds,
      selectedPlanItemCount: binding.itemIds.length,
    };
  }
  if (binding.mode === "extend") {
    return {
      planBindingMode: "extend",
      plannedItemCount: binding.extension.items.length,
      selectedPlanItemIndexes: binding.selectedItemIndexes,
      selectedPlanItemCount: binding.selectedItemIndexes.length,
    };
  }
  return {
    planBindingMode: "declare",
    plannedItemCount: binding.plan.items.length,
    selectedPlanItemIndexes: binding.selectedItemIndexes,
    selectedPlanItemCount: binding.selectedItemIndexes.length,
  };
}
