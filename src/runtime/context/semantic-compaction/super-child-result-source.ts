import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import { projectStoredCompletedRoleChild } from "../../orchestration/role-calls/child-return.js";
import { buildSupervisorChildContinuationParts } from "../../steps/supervisor-decision/resume.js";
import { buildPlannerCompletedChildMessages } from "../../steps/planner-decision/resume.js";
import type { SemanticCompactionSource } from "./contracts.js";
import { readStoredSourceMessage } from "./super-source-message.js";

/** Validates a historical return against immutable child/result facts, not the current revision. */
export function assertHistoricalChildResultSource(params: {
  source: SemanticCompactionSource;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
}): void {
  const { source, head, call } = params;
  const message = readStoredSourceMessage(source);
  const record = JSON.parse(message.content);
  if (record.kind !== "runtime_child_result")
    throw new Error("context_compaction_child_source_invalid");
  if (source.sourceRef !== `child-result:${record.resultRef}`)
    throw new Error("context_compaction_child_source_invalid");
  if (record.callerCallId !== call.callId)
    throw new Error("context_compaction_child_caller_invalid");
  if (!call.childCallIds.includes(record.childCallId))
    throw new Error("context_compaction_child_lineage_invalid");
  const child = projectStoredCompletedRoleChild(
    head.state,
    { callerCallId: call.callId, childCallId: record.childCallId },
    head.policy,
  );
  const resume = {
    callerCallId: call.callId,
    invocationAttempt: call.activationCount,
    returnedChildCallId: child.childCallId,
    returnedResultRef: child.resultRef,
    completedChildren: [child],
  };
  const input = {
    resume,
    currentCallId: call.callId,
    currentInvocationAttempt: call.activationCount,
  };
  if (call.roleId === "supervisor") {
    const parts = buildSupervisorChildContinuationParts(input);
    const messages = parts.flatMap((part) => [
      ...part.messages,
      ...(part.compactMessages ?? []),
    ]);
    if (
      !messages.some(
        (candidate) => JSON.stringify(candidate) === source.content,
      )
    )
      throw new Error("context_compaction_child_evidence_changed");
    return;
  }
  if (call.roleId !== "planner")
    throw new Error("context_compaction_source_family_not_owned");
  const messages = [
    ...buildPlannerCompletedChildMessages(child, call.callId, false),
    // This flag selects an existing historical projection shape; it adds no plan authority.
    ...buildPlannerCompletedChildMessages(child, call.callId, true),
  ];
  if (
    !messages.some((candidate) => JSON.stringify(candidate) === source.content)
  )
    throw new Error("context_compaction_child_evidence_changed");
}
