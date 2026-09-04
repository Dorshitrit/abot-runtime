import { exactKeys, isRecord } from "../../validation/strict-record.js";
import {
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallFrame,
  type RoleCallPolicy,
  type RoleCallResult,
  type RoleCallState,
} from "./contracts.js";
import {
  createCanonicalRoleCallWorkResultLineage,
  projectRoleCallWorkResultLineage,
} from "./work-result-lineage.js";

export const ROLE_CALL_WORK_RESULT_RECEIPT_KIND = "work_result_v1" as const;
export const ROLE_CALL_WORK_RESULT_FINGERPRINT_PATTERN =
  /^sha256:[a-f0-9]{64}$/u;
const ROLE_CALL_WORK_RESULT_REFERENCE_MAX_LENGTH = 256;

export type RoleCallWorkResultReceipt = Readonly<{
  kind: typeof ROLE_CALL_WORK_RESULT_RECEIPT_KIND;
  producerCallId: string;
  callerCallId: string;
  sourceRevision: number;
  lineageFingerprint: string;
  plannerPlanRef?: Readonly<{
    planId: string;
    planVersion: number;
  }>;
}>;

export type CanonicalRoleCallWorkResultReceiptInput = Readonly<{
  state: RoleCallState;
  caller: RoleCallFrame;
  child: RoleCallFrame;
  resultRef: string;
  outcome: RoleCallResult["outcome"];
  policy: RoleCallPolicy;
  admittedHeadRevision: number | undefined;
}>;

export function normalizeRoleCallWorkResultReceipt(
  input: unknown,
): RoleCallWorkResultReceipt | undefined | null {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return null;
  if (!hasExactWorkResultReceiptKeys(input)) return null;
  if (input.kind !== ROLE_CALL_WORK_RESULT_RECEIPT_KIND) return null;
  if (!isBoundedReference(input.producerCallId)) return null;
  if (!isBoundedReference(input.callerCallId)) return null;
  if (!isNonNegativeSafeInteger(input.sourceRevision)) return null;
  if (!isLineageFingerprint(input.lineageFingerprint)) return null;
  const plannerPlanRef = normalizePlannerPlanReference(input.plannerPlanRef);
  if (plannerPlanRef === null) return null;
  const receipt: RoleCallWorkResultReceipt = {
    kind: ROLE_CALL_WORK_RESULT_RECEIPT_KIND,
    producerCallId: input.producerCallId.trim(),
    callerCallId: input.callerCallId.trim(),
    sourceRevision: input.sourceRevision,
    lineageFingerprint: input.lineageFingerprint,
    ...(plannerPlanRef ? { plannerPlanRef } : {}),
  };
  if (JSON.stringify(receipt).length > ROLE_CALL_RESULT_MAX_LENGTH) return null;
  return deepFreeze(receipt);
}

export function mustIssueSupervisorWorkResultReceipt(input: {
  child: RoleCallFrame;
  policy: RoleCallPolicy;
}): boolean {
  if (input.child.roleId !== "planner" && input.child.roleId !== "worker") {
    return false;
  }
  const expected = SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT;
  return (
    input.policy.authority.id === expected.id &&
    input.policy.authority.version === expected.version &&
    input.policy.authority.definitionHash === expected.definitionHash
  );
}

export function createCanonicalRoleCallWorkResultReceipt(
  input: CanonicalRoleCallWorkResultReceiptInput,
): RoleCallWorkResultReceipt | null {
  if (!mustIssueSupervisorWorkResultReceipt(input)) return null;
  if (!hasCanonicalReturnBinding(input)) return null;
  const sourceRevision = input.admittedHeadRevision;
  if (sourceRevision === undefined) return null;
  const lineage = createCanonicalRoleCallWorkResultLineage({
    state: input.state,
    producer: input.child,
    resultRef: input.resultRef,
    outcome: input.outcome,
    sourceRevision,
  });
  if (!lineage) return null;
  const receipt = normalizeRoleCallWorkResultReceipt({
    kind: ROLE_CALL_WORK_RESULT_RECEIPT_KIND,
    producerCallId: input.child.callId,
    callerCallId: input.caller.callId,
    sourceRevision,
    lineageFingerprint: lineage.lineageFingerprint,
    ...(lineage.planner
      ? {
          plannerPlanRef: {
            planId: lineage.planner.planId,
            planVersion: lineage.planner.planVersion,
          },
        }
      : {}),
  });
  return receipt ?? null;
}

export function isRoleCallWorkResultReceiptValidForStoredResult(input: {
  state: RoleCallState;
  receipt: RoleCallWorkResultReceipt;
  producer: RoleCallFrame;
  result: RoleCallResult;
  policy: RoleCallPolicy;
}): boolean {
  const receipt = normalizeRoleCallWorkResultReceipt(input.receipt);
  if (!receipt) return false;
  if (!mustIssueSupervisorWorkResultReceipt({
    child: input.producer,
    policy: input.policy,
  })) {
    return false;
  }
  if (!isStoredResultBoundToReceipt(input, receipt)) return false;
  return projectRoleCallWorkResultLineage({
    state: input.state,
    receipt,
  }) !== null;
}

function hasExactWorkResultReceiptKeys(
  input: Record<string, unknown>,
): boolean {
  return exactKeys(
    input,
    [
      "kind",
      "producerCallId",
      "callerCallId",
      "sourceRevision",
      "lineageFingerprint",
    ],
    ["plannerPlanRef"],
  );
}

function normalizePlannerPlanReference(
  input: unknown,
): RoleCallWorkResultReceipt["plannerPlanRef"] | undefined | null {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return null;
  if (!exactKeys(input, ["planId", "planVersion"])) return null;
  if (!isBoundedReference(input.planId)) return null;
  if (!isPositiveSafeInteger(input.planVersion)) return null;
  return Object.freeze({
    planId: input.planId.trim(),
    planVersion: input.planVersion,
  });
}

function hasCanonicalReturnBinding(
  input: CanonicalRoleCallWorkResultReceiptInput,
): boolean {
  if (!isNonNegativeSafeInteger(input.admittedHeadRevision)) return false;
  if (!isBoundedReference(input.resultRef)) return false;
  if (input.state.phase !== "running") return false;
  if (input.state.activeCallId !== input.child.callId) return false;
  const canonicalCaller = input.state.calls.find(
    ({ callId }) => callId === input.caller.callId,
  );
  const canonicalChild = input.state.calls.find(
    ({ callId }) => callId === input.child.callId,
  );
  if (canonicalCaller !== input.caller || canonicalChild !== input.child) {
    return false;
  }
  if (input.caller.status !== "waiting_for_child") return false;
  if (input.child.status !== "active" || input.child.resultRef !== null) {
    return false;
  }
  if (input.child.parentCallId !== input.caller.callId) return false;
  if (!input.caller.childCallIds.includes(input.child.callId)) return false;
  return input.outcome === "completed" || input.outcome === "failed";
}

function isStoredResultBoundToReceipt(
  input: {
    state: RoleCallState;
    producer: RoleCallFrame;
    result: RoleCallResult;
  },
  receipt: RoleCallWorkResultReceipt,
): boolean {
  if (input.producer.callId !== receipt.producerCallId) return false;
  if (input.producer.parentCallId !== receipt.callerCallId) return false;
  if (input.producer.status !== "completed") return false;
  if (input.producer.resultRef !== input.result.resultRef) return false;
  if (input.result.producerCallId !== input.producer.callId) return false;
  if (input.result.roleId !== input.producer.roleId) return false;
  return input.state.results.includes(input.result);
}

function isBoundedReference(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    input.length <= ROLE_CALL_WORK_RESULT_REFERENCE_MAX_LENGTH
  );
}

function isNonNegativeSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}

function isPositiveSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 1;
}

function isLineageFingerprint(input: unknown): input is string {
  return (
    typeof input === "string" &&
    ROLE_CALL_WORK_RESULT_FINGERPRINT_PATTERN.test(input)
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
