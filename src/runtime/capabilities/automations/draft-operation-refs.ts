import type { AutomationRevision, WorkflowNode } from "../../automations/definition-contracts.js";
import { automationCatalogOperationRef } from "./authoring-catalog.js";
import { AUTOMATION_AUTHORING_PREPARATION_LIMITS } from "./authoring-preparation-limits.js";

function collectNodeOperationRefs(node: WorkflowNode, refs: Set<string>): void {
  if (node.kind === "sequence") {
    for (const child of node.children) collectNodeOperationRefs(child, refs);
    return;
  }
  if (node.kind === "parallel") {
    for (const branch of node.branches) collectNodeOperationRefs(branch, refs);
    return;
  }
  if (node.kind === "tool") {
    refs.add(automationCatalogOperationRef(node.operation));
    return;
  }
  for (const selected of node.tools) refs.add(automationCatalogOperationRef(selected.operation));
}

/** Exact draft identities for preparation; presence does not imply current availability or permission. */
export function automationDraftOperationRefs(definition: AutomationRevision): readonly string[] {
  const refs = new Set<string>();
  collectNodeOperationRefs(definition.body, refs);
  return [...refs];
}

function requiresPreparationSelection(operationRefCount: number): boolean {
  return operationRefCount > AUTOMATION_AUTHORING_PREPARATION_LIMITS.operationRefs;
}

/** Full saved-draft inventory, not a preparation selection or permission grant. */
export function automationDraftPreparationReceipt(definition: AutomationRevision) {
  const operationRefs = automationDraftOperationRefs(definition);
  return { operationRefs, preparation: {
    operationRefLimit: AUTOMATION_AUTHORING_PREPARATION_LIMITS.operationRefs,
    requiresSelection: requiresPreparationSelection(operationRefs.length),
  } };
}
