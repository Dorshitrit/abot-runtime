import { Buffer } from "node:buffer";
import type { AutomationRevision, OperationRef } from "../../automations/definition-contracts.js";
import type { AutomationService } from "../../automations/service.js";
import { findAutomationStep, type AutomationStepNode } from "../../automations/step-evidence-effects.js";

export function isAutomationAuthoringInputAction(action: string): boolean {
  return ["bind_step_result", "set_step_literal", "select_agent_tool"].includes(action);
}

function requiredText(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`automation_${name}_required`);
  return value.trim();
}

function positiveInteger(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`automation_${name}_invalid`);
  return Number(value);
}

function literalValue(params: Record<string, unknown>): unknown {
  const source = params.valueJson;
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 4_096)
    throw new Error("automation_graph_invalid");
  try { return JSON.parse(source); }
  catch { throw new Error("automation_graph_invalid"); }
}

function sameOperation(left: OperationRef, right: OperationRef): boolean {
  return left.toolName === right.toolName && left.operationId === right.operationId &&
    left.contractVersion === right.contractVersion;
}

function selectedToolsPatch(node: AutomationStepNode, params: Record<string, unknown>): Record<string, unknown> {
  if (node.kind !== "agent") throw new Error("automation_graph_invalid");
  const operation = { toolName: requiredText(params, "toolName"),
    operationId: requiredText(params, "operationId"), contractVersion: positiveInteger(params, "contractVersion") };
  const selected = { operation, usage: params.usage };
  const existing = node.tools.findIndex((tool) => sameOperation(tool.operation, operation));
  const tools = node.tools.filter((tool, index) => index === existing || !sameOperation(tool.operation, operation));
  const isNewSelection = existing < 0;
  if (isNewSelection) return { tools: [...tools, selected] };
  return { tools: tools.map((tool, index) => index === existing ? selected : tool) };
}

function resultBinding(definition: AutomationRevision, params: Record<string, unknown>): Record<string, unknown> {
  const sourceNodeId = requiredText(params, "sourceNodeId");
  const sourceFound = findAutomationStep(definition.body, sourceNodeId) !== null;
  if (!sourceFound) throw new Error("automation_dependency_missing");
  return { kind: "node_result", nodeId: sourceNodeId, select: params.select,
    ...(params.pointer === undefined ? {} : { pointer: params.pointer }) };
}

function bindingPatch(
  action: string, definition: AutomationRevision, node: AutomationStepNode, params: Record<string, unknown>,
): Record<string, unknown> {
  const inputName = requiredText(params, "inputName");
  const isLiteralBinding = action === "set_step_literal";
  const binding = isLiteralBinding ? { kind: "literal", value: literalValue(params) }
    : resultBinding(definition, params);
  const field = node.kind === "agent" ? "inputs" : "controls";
  const current = node.kind === "agent" ? node.inputs : node.controls;
  return { [field]: { ...current, [inputName]: binding } };
}

/** The parser and revision-checked draft service remain the sole mutation authority. */
export async function executeAutomationAuthoringInput(
  service: AutomationService, params: Record<string, unknown>,
): Promise<{ automationId: string; revision: number; newNodeIds: readonly string[]; sourceId?: string }> {
  const action = requiredText(params, "action");
  if (!isAutomationAuthoringInputAction(action)) throw new Error("automation_action_unknown");
  const automationId = requiredText(params, "automationId");
  const expectedRevision = positiveInteger(params, "expectedRevision");
  const draft = await service.getDraft(automationId);
  if (!draft) throw new Error("automation_not_found");
  const revisionMatches = draft.revision === expectedRevision;
  if (!revisionMatches) throw new Error("automation_revision_conflict");
  const nodeId = requiredText(params, "nodeId");
  const node = findAutomationStep(draft.definition.body, nodeId);
  if (!node) throw new Error("automation_dependency_missing");
  const isToolSelection = action === "select_agent_tool";
  const patch = isToolSelection ? selectedToolsPatch(node, params)
    : bindingPatch(action, draft.definition, node, params);
  const next = await service.updateDraft(automationId, expectedRevision, { kind: "update_node", nodeId, patch });
  return { automationId, revision: next.revision, newNodeIds: [],
    ...(next.definition.source ? { sourceId: next.definition.source.sourceId } : {}) };
}
