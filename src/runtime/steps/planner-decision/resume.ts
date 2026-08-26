import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestContextPinnedPart } from "../../context/request-context-contracts.js";
import type {
  CompletedRoleChildResult,
  RoleChildReturnContext,
} from "../../orchestration/role-calls/index.js";
import type { PlannerDecisionPlanContext } from "./contracts.js";

export function buildPlannerChildContinuationMessages(params: {
  resume: RoleChildReturnContext;
  currentCallId: string;
  currentInvocationAttempt: number;
  planContext?: PlannerDecisionPlanContext;
}): readonly ChatMessage[] {
  if (
    params.resume.callerCallId !== params.currentCallId ||
    params.resume.invocationAttempt !== params.currentInvocationAttempt ||
    params.resume.completedChildren.length === 0
  ) {
    throw new Error("planner_child_resume_caller_mismatch");
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
    throw new Error("planner_child_resume_result_mismatch");
  }

  return Object.freeze(
    params.resume.completedChildren.flatMap((child) =>
      buildCompletedChildMessages(
        child,
        params.currentCallId,
        params.planContext !== undefined,
      ),
    ),
  );
}

export function buildPlannerChildContinuationPart(params: {
  resume: RoleChildReturnContext;
  currentCallId: string;
  currentInvocationAttempt: number;
  planContext?: PlannerDecisionPlanContext;
}): RequestContextPinnedPart {
  const messages = buildPlannerChildContinuationMessages(params);
  return Object.freeze({
    sourceRef: [
      "planner-children",
      params.currentCallId,
      String(params.currentInvocationAttempt),
      params.resume.returnedResultRef,
    ].join(":"),
    category: "role_continuation",
    retention: "compactable",
    messages,
    compactMessages: Object.freeze(
      params.resume.completedChildren.map(
        (child) =>
          buildCompletedChildMessages(child, params.currentCallId, true)[0]!,
      ),
    ),
  });
}

function buildCompletedChildMessages(
  child: CompletedRoleChildResult,
  currentCallId: string,
  hasCanonicalPlanContext: boolean,
): readonly ChatMessage[] {
  if (child.callerCallId !== currentCallId) {
    throw new Error("planner_child_resume_caller_mismatch");
  }
  const resultMessage = Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: "runtime_child_result",
      callerCallId: child.callerCallId,
      childCallId: child.childCallId,
      resultRef: child.resultRef,
      roleId: child.roleId,
      ...(hasCanonicalPlanContext
        ? {
            delegatedObjective: child.objective,
            ...(child.roleId === "worker" && child.workingDirectory
              ? { workingDirectory: child.workingDirectory }
              : {}),
            ...(child.workerCapabilityScope
              ? { workerCapabilityScope: child.workerCapabilityScope }
              : {}),
            dependencyResultRefs: child.dependencyResultRefs,
          }
        : {}),
      outcome: child.outcome,
      summary: child.summary,
    }),
  });
  if (hasCanonicalPlanContext) {
    return Object.freeze([resultMessage]);
  }
  return Object.freeze([
    Object.freeze({
      role: "assistant" as const,
      content: JSON.stringify({
        action: "invoke_role",
        roleId: child.roleId,
        objective: child.objective,
        ...(child.roleId === "worker" && child.workingDirectory
          ? { workingDirectory: child.workingDirectory }
          : {}),
        ...(child.workerCapabilityScope
          ? { workerCapabilityScope: child.workerCapabilityScope }
          : {}),
      }),
    }),
    resultMessage,
  ]);
}
