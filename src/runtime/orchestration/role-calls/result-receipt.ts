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
  isRoleCallWorkResultReceiptValidForStoredResult,
  mustIssueSupervisorWorkResultReceipt,
  normalizeRoleCallWorkResultReceipt,
  ROLE_CALL_WORK_RESULT_RECEIPT_KIND,
  type RoleCallWorkResultReceipt,
} from "./work-result-receipt.js";

export const ROLE_CALL_REVIEWER_VERDICT_RECEIPT_KIND =
  "reviewer_verdict_v1" as const;
export const ROLE_CALL_REVIEWER_VERDICT_MAX_GAPS = 5;
export const ROLE_CALL_REVIEWER_VERDICT_MAX_REFS_PER_GAP = 1;
export const ROLE_CALL_REVIEWER_VERDICT_REFERENCE_MAX_LENGTH = 256;
export const ROLE_CALL_REVIEWER_VERDICT_KIND_MAX_LENGTH = 160;
export const ROLE_CALL_REVIEWER_VERDICT_GAP_SUMMARY_MAX_LENGTH = 224;

export type RoleCallReviewerVerdictGap = Readonly<{
  kind: string;
  subjectRefs: readonly string[];
  factRefs: readonly string[];
  evidenceRefs: readonly string[];
  summary: string;
}>;

export type RoleCallReviewerVerdictReceipt = Readonly<{
  kind: typeof ROLE_CALL_REVIEWER_VERDICT_RECEIPT_KIND;
  reviewerCallId: string;
  callerCallId: string;
  reviewScopeId: string;
  sourceRevision: number;
  verdict: "pass" | "report_gaps";
  gaps: readonly RoleCallReviewerVerdictGap[];
}>;

export type RoleCallResultReceipt =
  | RoleCallReviewerVerdictReceipt
  | RoleCallWorkResultReceipt;

export function createRoleCallReviewerVerdictReceipt(
  input: Omit<RoleCallReviewerVerdictReceipt, "kind">,
): RoleCallReviewerVerdictReceipt {
  const receipt = normalizeRoleCallReviewerVerdictReceipt({
    kind: ROLE_CALL_REVIEWER_VERDICT_RECEIPT_KIND,
    ...input,
  });
  if (!receipt) throw new Error("reviewer_verdict_receipt_invalid");
  return receipt;
}

export function normalizeRoleCallResultReceipt(
  input: unknown,
): RoleCallResultReceipt | undefined | null {
  if (input === undefined) return undefined;
  if (isRecord(input) && input.kind === ROLE_CALL_WORK_RESULT_RECEIPT_KIND) {
    return normalizeRoleCallWorkResultReceipt(input);
  }
  return normalizeRoleCallReviewerVerdictReceipt(input);
}

function normalizeRoleCallReviewerVerdictReceipt(
  input: unknown,
): RoleCallReviewerVerdictReceipt | null {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "kind",
      "reviewerCallId",
      "callerCallId",
      "reviewScopeId",
      "sourceRevision",
      "verdict",
      "gaps",
    ]) ||
    input.kind !== ROLE_CALL_REVIEWER_VERDICT_RECEIPT_KIND ||
    !isBoundedText(
      input.reviewerCallId,
      ROLE_CALL_REVIEWER_VERDICT_REFERENCE_MAX_LENGTH,
    ) ||
    !isBoundedText(
      input.callerCallId,
      ROLE_CALL_REVIEWER_VERDICT_REFERENCE_MAX_LENGTH,
    ) ||
    !isBoundedText(
      input.reviewScopeId,
      ROLE_CALL_REVIEWER_VERDICT_REFERENCE_MAX_LENGTH,
    ) ||
    !Number.isSafeInteger(input.sourceRevision) ||
    (input.sourceRevision as number) < 0 ||
    (input.verdict !== "pass" && input.verdict !== "report_gaps") ||
    !Array.isArray(input.gaps) ||
    input.gaps.length > ROLE_CALL_REVIEWER_VERDICT_MAX_GAPS ||
    (input.verdict === "pass" && input.gaps.length !== 0) ||
    (input.verdict === "report_gaps" && input.gaps.length === 0)
  ) {
    return null;
  }
  const gaps = input.gaps.map(normalizeGap);
  if (gaps.some((gap) => gap === null)) return null;
  const receipt: RoleCallReviewerVerdictReceipt = {
    kind: ROLE_CALL_REVIEWER_VERDICT_RECEIPT_KIND,
    reviewerCallId: input.reviewerCallId.trim(),
    callerCallId: input.callerCallId.trim(),
    reviewScopeId: input.reviewScopeId.trim(),
    sourceRevision: input.sourceRevision as number,
    verdict: input.verdict,
    gaps: gaps as readonly RoleCallReviewerVerdictGap[],
  };
  if (JSON.stringify(receipt).length > ROLE_CALL_RESULT_MAX_LENGTH) return null;
  return deepFreeze(receipt);
}

export function isRoleCallResultReceiptValidForReturn(params: {
  receipt: RoleCallResultReceipt | undefined;
  caller: RoleCallFrame;
  child: RoleCallFrame;
  outcome: RoleCallResult["outcome"];
  policy: RoleCallPolicy;
  admittedHeadRevision: number | undefined;
}): boolean {
  if (params.receipt === undefined) return true;
  if (params.receipt.kind === ROLE_CALL_WORK_RESULT_RECEIPT_KIND) return false;
  return (
    Number.isSafeInteger(params.admittedHeadRevision) &&
    params.receipt.sourceRevision === params.admittedHeadRevision &&
    isRoleCallResultReceiptBound({
      receipt: params.receipt,
      callerCallId: params.caller.callId,
      childCallId: params.child.callId,
      childRoleId: params.child.roleId,
      outcome: params.outcome,
      policy: params.policy,
    })
  );
}

export function isRoleCallResultReceiptValidForStoredResult(params: {
  receipt: RoleCallResultReceipt | undefined;
  producer: RoleCallFrame;
  result: RoleCallResult;
  policy: RoleCallPolicy;
  state?: RoleCallState;
}): boolean {
  if (params.receipt === undefined) {
    return !mustIssueSupervisorWorkResultReceipt({
      child: params.producer,
      policy: params.policy,
    });
  }
  if (params.receipt.kind === ROLE_CALL_WORK_RESULT_RECEIPT_KIND) {
    if (!params.state) return false;
    return isRoleCallWorkResultReceiptValidForStoredResult({
      state: params.state,
      producer: params.producer,
      result: params.result,
      receipt: params.receipt,
      policy: params.policy,
    });
  }
  return (
    params.producer.parentCallId !== null &&
    isRoleCallResultReceiptBound({
      receipt: params.receipt,
      callerCallId: params.producer.parentCallId,
      childCallId: params.producer.callId,
      childRoleId: params.producer.roleId,
      outcome: params.result.outcome,
      policy: params.policy,
    })
  );
}

export function isRoleCallReviewerVerdictReceiptBoundToChild(params: {
  receipt: RoleCallReviewerVerdictReceipt;
  callerCallId: string;
  childCallId: string;
  childRoleId: RoleCallFrame["roleId"];
  outcome: RoleCallResult["outcome"];
}): boolean {
  const normalized = normalizeRoleCallReviewerVerdictReceipt(params.receipt);
  return (
    normalized !== null &&
    normalized !== undefined &&
    params.childRoleId === "reviewer" &&
    params.outcome === "completed" &&
    normalized.reviewerCallId === params.childCallId &&
    normalized.callerCallId === params.callerCallId &&
    normalized.reviewScopeId ===
      `review:${params.childCallId}:r${normalized.sourceRevision}`
  );
}

function isRoleCallResultReceiptBound(params: {
  receipt: RoleCallReviewerVerdictReceipt;
  callerCallId: string;
  childCallId: string;
  childRoleId: RoleCallFrame["roleId"];
  outcome: RoleCallResult["outcome"];
  policy: RoleCallPolicy;
}): boolean {
  const normalized = normalizeRoleCallReviewerVerdictReceipt(params.receipt);
  return (
    normalized !== null &&
    normalized !== undefined &&
    hasDelegatedReviewerReceiptAuthority(params.policy) &&
    isRoleCallReviewerVerdictReceiptBoundToChild({
      receipt: normalized,
      callerCallId: params.callerCallId,
      childCallId: params.childCallId,
      childRoleId: params.childRoleId,
      outcome: params.outcome,
    })
  );
}

function hasDelegatedReviewerReceiptAuthority(policy: RoleCallPolicy): boolean {
  const expected = SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT;
  return (
    policy.authority.id === expected.id &&
    policy.authority.version === expected.version &&
    policy.authority.definitionHash === expected.definitionHash
  );
}

function normalizeGap(value: unknown): RoleCallReviewerVerdictGap | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "kind",
      "subjectRefs",
      "factRefs",
      "evidenceRefs",
      "summary",
    ]) ||
    !isBoundedText(value.kind, ROLE_CALL_REVIEWER_VERDICT_KIND_MAX_LENGTH) ||
    !isBoundedText(
      value.summary,
      ROLE_CALL_REVIEWER_VERDICT_GAP_SUMMARY_MAX_LENGTH,
    )
  ) {
    return null;
  }
  const subjectRefs = normalizeRefs(value.subjectRefs);
  const factRefs = normalizeRefs(value.factRefs);
  const evidenceRefs = normalizeRefs(value.evidenceRefs);
  if (!subjectRefs || !factRefs || !evidenceRefs) return null;
  return Object.freeze({
    kind: value.kind.trim(),
    subjectRefs,
    factRefs,
    evidenceRefs,
    summary: value.summary.trim(),
  });
}

function normalizeRefs(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > ROLE_CALL_REVIEWER_VERDICT_MAX_REFS_PER_GAP ||
    value.some(
      (entry) =>
        !isBoundedText(entry, ROLE_CALL_REVIEWER_VERDICT_REFERENCE_MAX_LENGTH),
    )
  ) {
    return null;
  }
  return Object.freeze(value.map((entry) => entry.trim()));
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
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
