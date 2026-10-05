import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../ports.js";
import type { AutomationCatalogOperation } from "./catalog.js";
import type { AgentNode, AutomationRevision, OperationRef } from "./definition-contracts.js";
import { compileAutomationGraph } from "./graph-validation.js";
import { projectAutomationModelDependencies } from "./model-dependency-projection.js";

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item);
}

function operationKey(operation: OperationRef): string {
  return JSON.stringify([operation.toolName, operation.operationId, operation.contractVersion]);
}

function executionContract(operation: AutomationCatalogOperation | undefined) {
  if (!operation) return null;
  const hasFixedExecutionParameters = operation.fixedParams !== undefined
    && Object.keys(operation.fixedParams).length > 0;
  return {
    toolName: operation.toolName,
    operationId: operation.operationId,
    contractVersion: operation.contractVersion,
    permissionMode: operation.permissionMode,
    effect: operation.effect,
    approval: operation.approval,
    input: operation.input,
    ...(hasFixedExecutionParameters ? { fixedParams: operation.fixedParams } : {}),
    payload: operation.payload ?? null,
    attachmentInput: operation.attachmentInput ?? null,
    selectionControlIds: operation.selectionControlIds ?? null,
  };
}

/** A published Run must never silently switch its model or tool contract. */
export function fingerprintAutomationDependencies(input: {
  definition: AutomationRevision;
  config: RuntimeConfig;
  operations: readonly AutomationCatalogOperation[];
}): string {
  const compiled = compileAutomationGraph(input.definition);
  if (!compiled.ok) throw new Error("automation_graph_invalid");
  const selected: OperationRef[] = [];
  const agents: AgentNode[] = [];
  for (const step of compiled.graph.steps) {
    if (step.node.kind === "tool") selected.push(step.node.operation);
    else {
      agents.push(step.node);
      selected.push(...step.node.tools.map((item) => item.operation));
    }
  }
  const byKey = new Map(input.operations.map((operation) =>
    [operationKey(operation), operation]));
  const contracts = [...new Set(selected.map(operationKey))].sort().map((key) => ({
    key,
    contract: executionContract(byKey.get(key)),
  }));
  return createHash("sha256").update(stableJson({
    contracts,
    models: projectAutomationModelDependencies(input.config, agents),
  })).digest("hex");
}
