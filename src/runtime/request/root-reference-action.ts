import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
  RoleChildReturnContext,
} from "../orchestration/role-calls/index.js";
import { projectStoredCompletedRoleChild } from "../orchestration/role-calls/child-return.js";
import type { RootContractDecision } from "./root-contract.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import { performRootMemoryRecall } from "./root-memory-recall.js";
import { performRootSkillRead } from "./root-skill-read.js";

type RootReferenceDecision = Extract<
  RootContractDecision,
  { action: "recall_memory" | "list_skills" | "read_skills" }
>;
export function isRootReferenceDecision(
  decision: RootContractDecision,
): decision is RootReferenceDecision {
  return ["recall_memory", "list_skills", "read_skills"].includes(
    decision.action,
  );
}

/** Core reference actions use the same root loop without opening a child. */
export async function performRootReferenceAction(
  request: RequestExecutionScope,
  ledger: RoleCallLedger,
  activation: {
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
    decisionSteeringVersion: number;
    decision: RootReferenceDecision;
  },
  resume: RoleChildReturnContext | undefined,
): Promise<RoleChildReturnContext | undefined> {
  const params = {
    request,
    ledger,
    ...activation,
    steeringVersion: activation.decisionSteeringVersion,
    resume,
  };
  if (params.decision.action === "recall_memory") {
    await performRootMemoryRecall({ ...params, query: params.decision.query });
    return params.resume;
  }
  await performRootSkillRead({ ...params, decision: params.decision });
  return projectResumeAfterSkillRead(params.ledger.current(), params.resume);
}

/** A reference read advances the root activation without changing its completed children. */
function projectResumeAfterSkillRead(
  head: RoleCallLedgerHead,
  resume: RoleChildReturnContext | undefined,
): RoleChildReturnContext | undefined {
  if (!resume) return undefined;
  const call = head.state.calls.find(
    ({ callId }) => callId === resume.callerCallId,
  );
  if (
    !call ||
    call.callId !== head.state.rootCallId ||
    call.status !== "active"
  )
    throw new Error("skill_read_resume_caller_invalid");
  const completedChildren = call.childCallIds.flatMap((childCallId) => {
    const child = head.state.calls.find(({ callId }) => callId === childCallId);
    if (child?.status !== "completed") return [];
    return [
      projectStoredCompletedRoleChild(
        head.state,
        { callerCallId: call.callId, childCallId },
        head.policy,
      ),
    ];
  });
  if (
    !completedChildren.some(
      (child) =>
        child.childCallId === resume.returnedChildCallId &&
        child.resultRef === resume.returnedResultRef,
    )
  )
    throw new Error("skill_read_resume_result_invalid");
  return Object.freeze({
    ...resume,
    invocationAttempt: call.activationCount,
    completedChildren: Object.freeze(completedChildren),
  });
}
