import type { AutomationRevision, OperationRef, WorkflowNode } from "./definition-contracts.js";
import type { AutomationResultStore } from "./result-store.js";
import type { AutomationAttemptRecord, AutomationJournalState, AutomationResultRecord } from "./storage-records.js";

const MAX_REPORTED_EFFECTS = 24;
const MAX_REPORTED_ACTIONS = 4;
const MAX_ACTION_TYPE_CHARACTERS = 80;
const MAX_ACTION_TARGET_CHARACTERS = 240;

export type AutomationStepNode = Extract<WorkflowNode, { kind: "agent" | "tool" }>;
export type AutomationEffectEvidence = Readonly<{
  attemptId: string;
  nodeId: string;
  operation?: OperationRef;
  outcome: "succeeded" | "failed" | "rejected" | "uncertain" | "pending";
  effect?: "read_only" | "mutating" | "mixed";
  errorCode?: string;
  actions: readonly Readonly<{ type: string; target?: string }>[];
  omittedActions: number;
  lateEvidence?: Readonly<{
    status: "succeeded" | "failed" | "rejected";
    observedAt: string;
    errorCode?: string;
  }>;
}>;

export type AutomationRunEffectSummary = Readonly<{
  total: number;
  omitted: number;
  verifiedExecutions: number;
  unresolvedAttempts: number;
  entries: readonly AutomationEffectEvidence[];
}>;

export function findAutomationStep(root: AutomationRevision["body"], nodeId: string): AutomationStepNode | null {
  const pending: WorkflowNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.id === nodeId && (node.kind === "agent" || node.kind === "tool")) return node;
    if (node.kind === "sequence") pending.push(...node.children);
    if (node.kind === "parallel") pending.push(...node.branches);
  }
  return null;
}

function requireEffectResult(state: AutomationJournalState, attempt: AutomationAttemptRecord,
  kind: AutomationResultRecord["kind"]): AutomationResultRecord {
  const record = state.results.find((item) => item.id === attempt.settlementRef &&
    item.runId === attempt.runId && item.nodeId === attempt.nodeId && item.kind === kind);
  if (!record) throw new Error("automation_result_ref_invalid");
  return record;
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function completionActions(value: unknown): {
  actions: AutomationEffectEvidence["actions"];
  omittedActions: number;
} {
  if (!Array.isArray(value)) return { actions: [], omittedActions: 0 };
  const actions = value.slice(0, MAX_REPORTED_ACTIONS).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof (item as { type?: unknown }).type !== "string") return [];
    const action = item as { type: string; target?: unknown };
    return [{ type: bounded(action.type, MAX_ACTION_TYPE_CHARACTERS),
      ...(typeof action.target === "string"
        ? { target: bounded(action.target, MAX_ACTION_TARGET_CHARACTERS) } : {}) }];
  });
  return { actions, omittedActions: Math.max(0, value.length - actions.length) };
}

function selectedOperationMatches(selected: OperationRef, candidate: Partial<OperationRef>): boolean {
  return selected.toolName === candidate.toolName &&
    selected.operationId === candidate.operationId &&
    selected.contractVersion === candidate.contractVersion;
}

function requireSelectedAgentOperation(node: AutomationStepNode, value: unknown): OperationRef {
  if (node.kind !== "agent" || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("automation_result_invalid");
  const candidate = value as Partial<OperationRef>;
  const selected = node.tools.find((tool) => selectedOperationMatches(tool.operation, candidate));
  if (!selected) throw new Error("automation_result_invalid");
  return selected.operation;
}

function supplementalLateEvidence(attempt: AutomationAttemptRecord):
  AutomationEffectEvidence["lateEvidence"] {
  if (!attempt.lateSettlement) return undefined;
  const late = attempt.lateSettlement;
  return { status: late.status, observedAt: late.observedAt,
    ...(late.errorCode ? { errorCode: late.errorCode } : {}) };
}

function originalOutcome(attempt: AutomationAttemptRecord,
  execution: "succeeded" | "failed" | "rejected" | "uncertain"): AutomationEffectEvidence["outcome"] {
  if (attempt.state === "uncertain") return "uncertain";
  return execution;
}

function directToolEffect(node: AutomationStepNode, attempt: AutomationAttemptRecord,
  value: unknown): AutomationEffectEvidence {
  if (node.kind !== "tool" || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("automation_result_invalid");
  const saved = value as { kind?: unknown; code?: unknown; receipt?: unknown };
  const lateEvidence = supplementalLateEvidence(attempt);
  if (saved.kind === "rejected" || saved.kind === "uncertain") {
    return { attemptId: attempt.id, nodeId: node.id, operation: node.operation,
      outcome: originalOutcome(attempt, saved.kind), actions: [], omittedActions: 0,
      ...(typeof saved.code === "string" ? { errorCode: saved.code } : {}),
      ...(lateEvidence ? { lateEvidence } : {}) };
  }
  if (!saved.receipt || typeof saved.receipt !== "object" || Array.isArray(saved.receipt))
    throw new Error("automation_result_invalid");
  const receipt = saved.receipt as { ok?: unknown; effect?: unknown; errorCode?: unknown; completionActions?: unknown };
  if (typeof receipt.ok !== "boolean") throw new Error("automation_result_invalid");
  if (receipt.effect !== "read_only" && receipt.effect !== "mutating" && receipt.effect !== "mixed")
    throw new Error("automation_result_invalid");
  return { attemptId: attempt.id, nodeId: node.id, operation: node.operation,
    outcome: originalOutcome(attempt, receipt.ok ? "succeeded" : "failed"),
    effect: receipt.effect,
    ...completionActions(receipt.completionActions),
    ...(typeof receipt.errorCode === "string" ? { errorCode: receipt.errorCode } : {}),
    ...(lateEvidence ? { lateEvidence } : {}) };
}

function agentEffect(node: AutomationStepNode, attempt: AutomationAttemptRecord,
  value: unknown): AutomationEffectEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("automation_result_invalid");
  const saved = value as { operation?: unknown; outcome?: unknown };
  const operation = requireSelectedAgentOperation(node, saved.operation);
  if (!saved.outcome || typeof saved.outcome !== "object" || Array.isArray(saved.outcome))
    throw new Error("automation_result_invalid");
  const outcome = saved.outcome as {
    status?: unknown; effect?: unknown; code?: unknown; completionActions?: unknown;
    result?: { ok?: unknown; errorCode?: unknown };
  };
  if (outcome.status !== "executed" && outcome.status !== "rejected" && outcome.status !== "uncertain")
    throw new Error("automation_result_invalid");
  let original: "succeeded" | "failed" | "rejected" | "uncertain" = "rejected";
  if (outcome.status === "uncertain") original = "uncertain";
  if (outcome.status === "executed") original = outcome.result?.ok === true ? "succeeded" : "failed";
  const effect = outcome.effect === "read_only" || outcome.effect === "mutating" || outcome.effect === "mixed"
    ? outcome.effect : undefined;
  let errorCode: string | undefined;
  if (typeof outcome.result?.errorCode === "string") errorCode = outcome.result.errorCode;
  else if (typeof outcome.code === "string") errorCode = outcome.code;
  const lateEvidence = supplementalLateEvidence(attempt);
  return { attemptId: attempt.id, nodeId: node.id, operation, outcome: originalOutcome(attempt, original),
    ...(effect ? { effect } : {}),
    ...completionActions(outcome.status === "executed" ? outcome.completionActions : []),
    ...(errorCode ? { errorCode } : {}),
    ...(lateEvidence ? { lateEvidence } : {}) };
}

async function readAttempt(input: {
  state: AutomationJournalState;
  results: AutomationResultStore;
  node: AutomationStepNode;
  attempt: AutomationAttemptRecord;
}): Promise<AutomationEffectEvidence> {
  const { state, results, node, attempt } = input;
  if (!attempt.settlementRef) {
    if (attempt.state === "settled") throw new Error("automation_result_ref_invalid");
    const lateEvidence = supplementalLateEvidence(attempt);
    return { attemptId: attempt.id, nodeId: node.id,
      ...(node.kind === "tool" ? { operation: node.operation } : {}),
      outcome: attempt.state === "uncertain" ? "uncertain" : "pending",
      actions: [], omittedActions: 0,
      ...(lateEvidence ? { lateEvidence } : {}) };
  }
  const kind = node.kind === "tool" ? "node_output" : "effect_receipt";
  const record = requireEffectResult(state, attempt, kind);
  const value = await results.read(record);
  if (node.kind === "tool") return directToolEffect(node, attempt, value);
  return agentEffect(node, attempt, value);
}

export async function readAutomationStepEffects(input: {
  state: AutomationJournalState;
  results: AutomationResultStore;
  runId: string;
  node: AutomationStepNode;
}): Promise<AutomationEffectEvidence[]> {
  const attempts = input.state.attempts.filter((item) => item.runId === input.runId &&
    item.nodeId === input.node.id);
  return Promise.all(attempts.map((attempt) => readAttempt({
    state: input.state, results: input.results, node: input.node, attempt,
  })));
}

export async function readAutomationRunEffectSummary(input: {
  state: AutomationJournalState;
  results: AutomationResultStore;
  runId: string;
  definition: AutomationRevision;
}): Promise<AutomationRunEffectSummary> {
  const attempts = input.state.attempts.filter((item) => item.runId === input.runId);
  const all = await Promise.all(attempts.map((attempt) => {
    const node = findAutomationStep(input.definition.body, attempt.nodeId);
    if (!node) throw new Error("automation_node_not_found");
    return readAttempt({ state: input.state, results: input.results, node, attempt });
  }));
  const entries = all.slice(0, MAX_REPORTED_EFFECTS);
  return { total: attempts.length, omitted: attempts.length - entries.length,
    verifiedExecutions: all.filter((item) =>
      item.effect && (item.outcome === "succeeded" || item.outcome === "failed")).length,
    unresolvedAttempts: all.filter((item) =>
      item.outcome === "uncertain" || item.outcome === "pending").length,
    entries };
}

/** Overlay late evidence without changing the original attempt outcome or saved receipt actions. */
export function withCurrentLateEvidence(
  summary: AutomationRunEffectSummary,
  attempts: readonly AutomationAttemptRecord[],
): AutomationRunEffectSummary {
  const lateById = new Map(attempts.filter((item) => item.lateSettlement)
    .map((item) => [item.id, supplementalLateEvidence(item)]));
  return {
    ...summary,
    entries: summary.entries.map((entry) => {
      const lateEvidence = lateById.get(entry.attemptId);
      return lateEvidence ? { ...entry, lateEvidence } : entry;
    }),
  };
}
