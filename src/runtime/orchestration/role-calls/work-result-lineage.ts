import { createHash } from "node:crypto";

import type {
  RoleCallFrame,
  RoleCallPlanItemStatus,
  RoleCallResult,
  RoleCallState,
} from "./contracts.js";
import type { RoleCallWorkResultReceipt } from "./work-result-receipt.js";

export const ROLE_CALL_WORK_RESULT_LINEAGE_KIND =
  "work_result_lineage_v1" as const;

type TerminalPlanItemStatus = Exclude<
  RoleCallPlanItemStatus,
  "in_progress"
>;

export type RoleCallWorkResultPlanItem = Readonly<{
  itemId: string;
  status: TerminalPlanItemStatus;
  resultRef: string | null;
}>;

export type RoleCallWorkResultPlanSnapshot = Readonly<{
  planId: string;
  planVersion: number;
  items: readonly RoleCallWorkResultPlanItem[];
}>;

export type RoleCallWorkResultLineage = Readonly<{
  kind: typeof ROLE_CALL_WORK_RESULT_LINEAGE_KIND;
  lineageFingerprint: string;
  capabilityExecutionIds: readonly string[];
  planner?: RoleCallWorkResultPlanSnapshot;
}>;

export type RoleCallWorkLineageProjection = RoleCallWorkResultLineage;

export type CanonicalRoleCallWorkResultLineageInput = Readonly<{
  state: RoleCallState;
  producer: RoleCallFrame;
  resultRef: string;
  outcome: RoleCallResult["outcome"];
  sourceRevision: number;
}>;

export function createCanonicalRoleCallWorkResultLineage(
  input: CanonicalRoleCallWorkResultLineageInput,
): RoleCallWorkResultLineage | null {
  if (!hasCanonicalWorkResultIdentity(input)) return null;
  const capabilityExecutionIds = resolveSubtreeCapabilityExecutionIds(
    input.state,
    input.producer,
  );
  if (!capabilityExecutionIds) return null;
  const planner = resolvePlannerSnapshot(input.state, input.producer);
  if (planner === null) return null;
  const callerCallId = input.producer.parentCallId;
  if (!callerCallId) return null;
  const lineageFingerprint = createLineageFingerprint({
    resultRef: input.resultRef,
    producerCallId: input.producer.callId,
    callerCallId,
    roleId: input.producer.roleId,
    outcome: input.outcome,
    sourceRevision: input.sourceRevision,
    dependencyResultRefs: input.producer.dependencyResultRefs,
    capabilityExecutionIds,
    ...(planner ? { planner } : {}),
  });
  return deepFreeze({
    kind: ROLE_CALL_WORK_RESULT_LINEAGE_KIND,
    lineageFingerprint,
    capabilityExecutionIds,
    ...(planner ? { planner } : {}),
  });
}

export function projectRoleCallWorkResultLineage(input: {
  state: RoleCallState;
  receipt: RoleCallWorkResultReceipt;
}): RoleCallWorkResultLineage | null {
  const result = findUniqueProducerResult(input.state, input.receipt);
  if (!result) return null;
  const producer = input.state.calls.find(
    ({ callId }) => callId === input.receipt.producerCallId,
  );
  if (!producer || !isStoredResultBoundToProducer(producer, result)) {
    return null;
  }
  if (producer.parentCallId !== input.receipt.callerCallId) return null;
  const lineage = createCanonicalRoleCallWorkResultLineage({
    state: input.state,
    producer,
    resultRef: result.resultRef,
    outcome: result.outcome,
    sourceRevision: input.receipt.sourceRevision,
  });
  if (!lineage) return null;
  if (lineage.lineageFingerprint !== input.receipt.lineageFingerprint) {
    return null;
  }
  if (!matchesPlannerPlanReference(lineage, input.receipt)) return null;
  return lineage;
}

function hasCanonicalWorkResultIdentity(
  input: CanonicalRoleCallWorkResultLineageInput,
): boolean {
  if (input.producer.roleId !== "planner" && input.producer.roleId !== "worker") {
    return false;
  }
  if (!input.producer.parentCallId) return false;
  if (!input.resultRef.trim()) return false;
  if (input.outcome !== "completed" && input.outcome !== "failed") return false;
  return Number.isSafeInteger(input.sourceRevision) && input.sourceRevision >= 0;
}

function resolveSubtreeCapabilityExecutionIds(
  state: RoleCallState,
  producer: RoleCallFrame,
): readonly string[] | null {
  const subtreeCallIds = resolveSubtreeCallIds(state, producer);
  if (!subtreeCallIds) return null;
  const executions = state.capabilityExecutions.filter(({ callId }) =>
    subtreeCallIds.has(callId),
  );
  if (executions.some(({ status }) => status !== "settled")) return null;
  return Object.freeze(executions.map(({ executionId }) => executionId));
}

function resolveSubtreeCallIds(
  state: RoleCallState,
  producer: RoleCallFrame,
): ReadonlySet<string> | null {
  const callById = new Map(state.calls.map((call) => [call.callId, call]));
  if (callById.get(producer.callId) !== producer) return null;
  const visited = new Set<string>();
  const pending = [producer.callId];
  while (pending.length > 0) {
    const callId = pending.pop();
    if (!callId || visited.has(callId)) return null;
    const call = callById.get(callId);
    if (!call) return null;
    visited.add(callId);
    for (const childCallId of call.childCallIds) {
      const child = callById.get(childCallId);
      if (!child || child.parentCallId !== callId) return null;
      pending.push(childCallId);
    }
  }
  return visited;
}

function resolvePlannerSnapshot(
  state: RoleCallState,
  producer: RoleCallFrame,
): RoleCallWorkResultPlanSnapshot | undefined | null {
  if (producer.roleId !== "planner") return undefined;
  const plans = state.plans.filter(
    ({ definition }) => definition.plannerCallId === producer.callId,
  );
  if (plans.length === 0) return undefined;
  if (plans.length !== 1) return null;
  const plan = plans[0]!;
  if (plan.definition.items.length !== plan.itemStates.length) return null;
  const items = plan.definition.items.map(({ itemId }) => {
    const itemState = plan.itemStates.find((item) => item.itemId === itemId);
    return itemState
      ? resolveTerminalPlanItem(state, producer, itemState)
      : null;
  });
  if (items.some((item) => item === null)) return null;
  return deepFreeze({
    planId: plan.definition.planId,
    planVersion: plan.definition.version,
    items: items as readonly RoleCallWorkResultPlanItem[],
  });
}

function resolveTerminalPlanItem(
  state: RoleCallState,
  producer: RoleCallFrame,
  item: RoleCallState["plans"][number]["itemStates"][number],
): RoleCallWorkResultPlanItem | null {
  if (item.status === "in_progress") return null;
  if (item.status === "pending") {
    if (item.childCallId !== null) return null;
    return Object.freeze({
      itemId: item.itemId,
      status: item.status,
      resultRef: null,
    });
  }
  if (!item.childCallId) return null;
  const child = state.calls.find(({ callId }) => callId === item.childCallId);
  if (!child || child.parentCallId !== producer.callId || !child.resultRef) {
    return null;
  }
  const result = state.results.find(
    ({ resultRef }) => resultRef === child.resultRef,
  );
  if (!result || result.producerCallId !== child.callId) return null;
  return Object.freeze({
    itemId: item.itemId,
    status: item.status,
    resultRef: result.resultRef,
  });
}

function findUniqueProducerResult(
  state: RoleCallState,
  receipt: RoleCallWorkResultReceipt,
): RoleCallResult | undefined {
  const results = state.results.filter(
    ({ producerCallId }) => producerCallId === receipt.producerCallId,
  );
  return results.length === 1 ? results[0] : undefined;
}

function isStoredResultBoundToProducer(
  producer: RoleCallFrame,
  result: RoleCallResult,
): boolean {
  return (
    producer.status === "completed" &&
    producer.resultRef === result.resultRef &&
    producer.roleId === result.roleId
  );
}

function matchesPlannerPlanReference(
  lineage: RoleCallWorkResultLineage,
  receipt: RoleCallWorkResultReceipt,
): boolean {
  if (!lineage.planner) return receipt.plannerPlanRef === undefined;
  return (
    receipt.plannerPlanRef?.planId === lineage.planner.planId &&
    receipt.plannerPlanRef.planVersion === lineage.planner.planVersion
  );
}

function createLineageFingerprint(input: Readonly<Record<string, unknown>>): string {
  const canonical = JSON.stringify({
    kind: ROLE_CALL_WORK_RESULT_LINEAGE_KIND,
    ...input,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
