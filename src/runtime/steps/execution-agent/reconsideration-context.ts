import { hasSettledMemoryRecallActivationRange } from "../../orchestration/role-calls/memory-recall-state-validation.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCapabilitySelectionReconsideration,
} from "../../orchestration/role-calls/index.js";
import {
  isRoleCapabilityReconsiderationBoundToScope,
  ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_INTERVENTION_COUNT,
  ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_LIMIT,
  ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_WARNING_COUNT,
  ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_INTERVENTION_COUNT,
  ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_LIMIT,
  ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_WARNING_COUNT,
} from "../../orchestration/role-calls/index.js";

export const EXECUTION_CAPABILITY_RECONSIDERATION_MESSAGE_KIND =
  "runtime_execution_capability_reconsideration_v1" as const;

export function projectImmediateCapabilityReconsideration(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  currentSteeringVersion?: number,
): Record<string, unknown> | undefined {
  const reconsideration = call.lastCapabilitySelectionReconsideration;
  if (!reconsideration) return undefined;
  if (
    currentSteeringVersion !== undefined &&
    !isRoleCapabilityReconsiderationBoundToScope({
      call,
      steeringVersion: currentSteeringVersion,
    })
  ) {
    return undefined;
  }
  if (
    !hasSettledMemoryRecallActivationRange(
      head.state,
      call.callId,
      reconsideration.invocationAttempt + 1,
      call.activationCount,
    )
  ) {
    return undefined;
  }
  return projectCapabilityReconsideration(
    reconsideration,
    projectImmediateCapabilitySelectionSupervision(head, call, reconsideration),
  );
}

function projectCapabilityReconsideration(
  reconsideration: RoleCapabilitySelectionReconsideration,
  supervision: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    kind: EXECUTION_CAPABILITY_RECONSIDERATION_MESSAGE_KIND,
    authority: "canonical_role_call_ledger",
    presenceEffect: "passive_continuity_not_next_action",
    outcome: "reconsidered_before_execution",
    executionOccurred: false,
    invocationAttempt: reconsideration.invocationAttempt,
    steeringVersion: reconsideration.steeringVersion,
    fingerprint: reconsideration.fingerprint,
    cause: reconsideration.cause,
    selection: {
      ...reconsideration.selection,
      invocations: reconsideration.selection.invocations.map((invocation) => ({
        capabilityId: invocation.capabilityId,
        selectionControls: JSON.parse(
          invocation.selectionControlsJson,
        ) as unknown,
      })),
    },
    ...(supervision ? { supervision } : {}),
  };
}

function projectImmediateCapabilitySelectionSupervision(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  reconsideration: RoleCapabilitySelectionReconsideration,
): Record<string, unknown> | undefined {
  const supervision = head.state.capabilitySelectionSupervision;
  const record = supervision.records.at(-1);
  if (
    !record ||
    record.stage === "tracking" ||
    supervision.epoch?.callId !== call.callId ||
    supervision.epoch.steeringVersion !== reconsideration.steeringVersion ||
    record.invocationAttempt !== reconsideration.invocationAttempt ||
    record.receiptFingerprint !== reconsideration.fingerprint
  ) {
    return undefined;
  }
  return Object.freeze({
    authority: "canonical_role_call_ledger",
    presenceEffect: "passive_mechanical_supervision_not_next_action",
    callId: call.callId,
    invocationAttempt: record.invocationAttempt,
    steeringVersion: supervision.epoch.steeringVersion,
    executionOccurred: false,
    stage: record.stage,
    trigger: record.trigger,
    selectionFingerprint: record.supervisionFingerprint,
    matchingSelectionCount: record.identityCount,
    totalReconsiderationCount: record.totalCount,
    limits: Object.freeze({
      repeat: Object.freeze({
        warningAt: ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_WARNING_COUNT,
        intervenedAt:
          ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_INTERVENTION_COUNT,
        terminalAt: ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_LIMIT,
      }),
      total: Object.freeze({
        warningAt: ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_WARNING_COUNT,
        intervenedAt:
          ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_INTERVENTION_COUNT,
        terminalAt: ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_LIMIT,
      }),
    }),
  });
}
