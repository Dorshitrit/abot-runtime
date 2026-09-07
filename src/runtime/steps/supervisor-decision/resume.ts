import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestContextPinnedPart } from "../../context/request-context-contracts.js";
import {
  isSupervisorDelegateRoleId,
  SUPERVISOR_OBJECTIVE_MAX_LENGTH,
  type SupervisorResumeContext,
} from "./contracts.js";
import {
  ROLE_CALL_RESULT_MAX_LENGTH,
  normalizeRoleCallWorkingDirectory,
  isRoleCallReviewerVerdictReceiptBoundToChild,
  normalizeRoleCallWorkResultReceipt,
  type CompletedRoleChildResult,
} from "../../orchestration/role-calls/index.js";

type SupervisorContinuationParams = Readonly<{
  resume: SupervisorResumeContext;
  currentCallId: string;
  currentInvocationAttempt: number;
}>;

export function buildSupervisorContinuationMessages(
  params: SupervisorContinuationParams,
): readonly ChatMessage[] {
  validateSupervisorContinuation(params);
  return Object.freeze(
    params.resume.completedChildren.flatMap((child) =>
      buildCompletedChildMessages(child, params.currentCallId),
    ),
  );
}

export function buildSupervisorContinuationPart(
  params: SupervisorContinuationParams,
): RequestContextPinnedPart {
  validateSupervisorContinuation(params);
  return Object.freeze({
    sourceRef: [
      "supervisor-children",
      params.currentCallId,
      String(params.currentInvocationAttempt),
      params.resume.returnedResultRef,
    ].join(":"),
    category: "role_continuation",
    retention: "compactable",
    messages: Object.freeze(
      params.resume.completedChildren.flatMap((child) =>
        buildCompletedChildMessages(child, params.currentCallId),
      ),
    ),
    compactMessages: Object.freeze(
      params.resume.completedChildren.map((child) =>
        buildCompactCompletedChildMessage(child, params.currentCallId),
      ),
    ),
  });
}

/** Keep each child's full and compact views at the same continuation position. */
export function buildSupervisorChildContinuationParts(
  params: SupervisorContinuationParams,
): readonly RequestContextPinnedPart[] {
  validateSupervisorContinuation(params);
  return Object.freeze(
    params.resume.completedChildren.map((child) =>
      Object.freeze({
        sourceRef: `supervisor-child:${params.currentCallId}:${child.resultRef}`,
        category: "role_continuation" as const,
        retention: "compactable" as const,
        messages: buildCompletedChildMessages(child, params.currentCallId),
        compactMessages: Object.freeze([
          buildCompactCompletedChildMessage(child, params.currentCallId),
        ]),
      }),
    ),
  );
}

function validateSupervisorContinuation(
  params: SupervisorContinuationParams,
): void {
  if (
    params.resume.callerCallId !== params.currentCallId ||
    params.resume.invocationAttempt !== params.currentInvocationAttempt ||
    params.resume.completedChildren.length === 0
  ) {
    throw new Error("supervisor_resume_caller_mismatch");
  }
  const returnedChild = params.resume.completedChildren.find(
    (child) =>
      child.childCallId === params.resume.returnedChildCallId &&
      child.resultRef === params.resume.returnedResultRef,
  );
  if (
    returnedChild?.childCallId !== params.resume.returnedChildCallId ||
    returnedChild.resultRef !== params.resume.returnedResultRef
  ) {
    throw new Error("supervisor_resume_result_mismatch");
  }
}

function buildCompletedChildMessages(
  child: CompletedRoleChildResult,
  currentCallId: string,
): readonly ChatMessage[] {
  validateCompletedChild(child, currentCallId);
  return Object.freeze([
    Object.freeze({
      role: "assistant" as const,
      content: JSON.stringify({
        action: "invoke_role",
        roleId: child.roleId,
        objective: child.objective,
        ...(child.workingDirectory !== undefined
          ? { workingDirectory: child.workingDirectory }
          : {}),
        ...(child.workerCapabilityScope
          ? { workerCapabilityScope: child.workerCapabilityScope }
          : {}),
      }),
    }),
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: "runtime_child_result",
        callerCallId: child.callerCallId,
        childCallId: child.childCallId,
        resultRef: child.resultRef,
        roleId: child.roleId,
        outcome: child.outcome,
        summary: child.summary,
        ...(child.workLineage
          ? { dependencyResultRefs: child.dependencyResultRefs }
          : {}),
        ...projectCompletedChildReceipt(child),
      }),
    }),
  ]);
}

function buildCompactCompletedChildMessage(
  child: CompletedRoleChildResult,
  currentCallId: string,
): ChatMessage {
  validateCompletedChild(child, currentCallId);
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: "runtime_child_result",
      callerCallId: child.callerCallId,
      childCallId: child.childCallId,
      resultRef: child.resultRef,
      roleId: child.roleId,
      delegatedObjective: child.objective,
      ...(child.workingDirectory !== undefined
        ? { workingDirectory: child.workingDirectory }
        : {}),
      ...(child.workerCapabilityScope
        ? { workerCapabilityScope: child.workerCapabilityScope }
        : {}),
      dependencyResultRefs: child.dependencyResultRefs,
      outcome: child.outcome,
      summary: child.summary,
      ...projectCompletedChildReceipt(child),
    }),
  });
}

function validateCompletedChild(
  child: CompletedRoleChildResult,
  currentCallId: string,
): void {
  if (child.callerCallId !== currentCallId) {
    throw new Error("supervisor_resume_caller_mismatch");
  }
  if (
    child.childCallId === child.callerCallId ||
    !child.childCallId ||
    !child.resultRef ||
    !isSupervisorDelegateRoleId(child.roleId) ||
    !boundedText(child.objective, SUPERVISOR_OBJECTIVE_MAX_LENGTH) ||
    (child.outcome !== "completed" && child.outcome !== "failed") ||
    !boundedText(child.summary, ROLE_CALL_RESULT_MAX_LENGTH)
  ) {
    throw new Error("supervisor_resume_child_invalid");
  }
  if (!hasValidCompletedChildReceiptProjection(child)) {
    throw new Error("supervisor_resume_child_invalid");
  }
  const workingDirectory = normalizeRoleCallWorkingDirectory(
    child.workingDirectory,
  );
  const workingDirectoryRequired =
    child.roleId === "planner" || child.roleId === "worker";
  if (
    (workingDirectoryRequired &&
      (workingDirectory === undefined ||
        workingDirectory !== child.workingDirectory)) ||
    (!workingDirectoryRequired && child.workingDirectory !== undefined)
  ) {
    throw new Error("supervisor_resume_child_invalid");
  }
}

function projectCompletedChildReceipt(
  child: CompletedRoleChildResult,
): Readonly<Record<string, unknown>> {
  if (!child.receipt) return Object.freeze({});
  if (child.receipt.kind === "work_result_v1") {
    return Object.freeze({
      workReceipt: child.receipt,
      workLineage: child.workLineage,
    });
  }
  return Object.freeze({ reviewerVerdict: child.receipt });
}

function hasValidCompletedChildReceiptProjection(
  child: CompletedRoleChildResult,
): boolean {
  if (!child.receipt) return child.workLineage === undefined;
  if (child.receipt.kind !== "work_result_v1") {
    if (child.workLineage !== undefined) return false;
    return isRoleCallReviewerVerdictReceiptBoundToChild({
      receipt: child.receipt,
      callerCallId: child.callerCallId,
      childCallId: child.childCallId,
      childRoleId: child.roleId,
      outcome: child.outcome,
    });
  }
  const receipt = normalizeRoleCallWorkResultReceipt(child.receipt);
  if (!receipt) return false;
  if (child.roleId !== "planner" && child.roleId !== "worker") return false;
  if (receipt.producerCallId !== child.childCallId) return false;
  if (receipt.callerCallId !== child.callerCallId) return false;
  if (child.workLineage?.kind !== "work_result_lineage_v1") return false;
  return child.workLineage.lineageFingerprint === receipt.lineageFingerprint;
}

function boundedText(value: string, maximumLength: number): boolean {
  return value.trim().length > 0 && value.length <= maximumLength;
}
