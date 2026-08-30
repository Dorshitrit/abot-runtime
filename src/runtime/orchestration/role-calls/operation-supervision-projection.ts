import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "./contracts.js";
import {
  isSameRoleOperationIdentity,
  type RoleOperationSupervisionEntry,
} from "./operation-supervision.js";

export const ROLE_OPERATION_SUPERVISION_NOTICE_KIND =
  "runtime_operation_supervision_v1" as const;

export type RoleOperationSupervisionNotice = Readonly<{
  kind: typeof ROLE_OPERATION_SUPERVISION_NOTICE_KIND;
  authority: "runtime_state";
  presenceEffect: "passive_mechanical_intervention_not_user_intent";
  stage: "warning" | "intervention";
  actionFingerprint: string;
  priorOutcome: "succeeded" | "failed";
  outcomeFingerprint: string;
  originExecutionId: string;
  matchingOutcomeCount: 2;
  interventionCount: 0 | 1;
}>;

/** Projects only supervision evidence created for this exact activation. */
export function projectImmediateRoleOperationSupervisionNotices(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): readonly RoleOperationSupervisionNotice[] {
  if (!isCurrentActiveCall(head, call)) return Object.freeze([]);
  const interventions = head.state.operationSupervision.entries.filter(
    (entry) =>
      entry.stage === "intervened" &&
      entry.interventionCallId === call.callId &&
      entry.interventionInvocationAttempt + 1 === call.activationCount,
  );
  if (interventions.length > 0) {
    return Object.freeze(
      interventions
        .map((entry) =>
          entry.stage === "intervened" ? createNotice(entry) : undefined,
        )
        .filter(
          (notice): notice is RoleOperationSupervisionNotice =>
            notice !== undefined,
        ),
    );
  }

  const notices = findImmediateSettledExecutions(head, call).flatMap(
    (execution) => {
      const actionFingerprint = execution.actionFingerprint;
      if (!actionFingerprint) return [];
      const warning = head.state.operationSupervision.entries.find(
        (entry) =>
          entry.stage === "warning" &&
          isSameRoleOperationIdentity(entry, {
            capabilityId: execution.capabilityId,
            actionFingerprint,
          }) &&
          entry.originExecutionId === execution.executionId,
      );
      return warning?.stage === "warning" ? [createNotice(warning)] : [];
    },
  );
  return Object.freeze(notices);
}

function createNotice(
  entry: Extract<
    RoleOperationSupervisionEntry,
    { stage: "warning" | "intervened" }
  >,
): RoleOperationSupervisionNotice {
  return Object.freeze({
    kind: ROLE_OPERATION_SUPERVISION_NOTICE_KIND,
    authority: "runtime_state" as const,
    presenceEffect: "passive_mechanical_intervention_not_user_intent" as const,
    stage: entry.stage === "intervened" ? "intervention" : "warning",
    actionFingerprint: entry.actionFingerprint,
    priorOutcome: entry.priorOutcome,
    outcomeFingerprint: entry.outcomeFingerprint,
    originExecutionId: entry.originExecutionId,
    matchingOutcomeCount: entry.matchingOutcomeCount,
    interventionCount:
      entry.stage === "intervened" ? entry.interventionCount : 0,
  });
}

function findImmediateSettledExecutions(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): readonly RoleCapabilityExecution[] {
  return head.state.capabilityExecutions.filter(
    (execution) =>
      execution.status === "settled" &&
      execution.callId === call.callId &&
      execution.invocationAttempt + 1 === call.activationCount,
  );
}

function isCurrentActiveCall(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): boolean {
  return (
    head.state.phase === "running" &&
    head.state.activeCallId === call.callId &&
    call.status === "active"
  );
}
