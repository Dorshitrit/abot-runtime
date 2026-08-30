import {
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallPolicy,
  type RoleCallState,
  type RoleCapabilityBatchSettlement,
  type RoleCapabilityExecution,
} from "../contracts.js";
import { advanceRoleOperationSupervisionSettlement } from "../operation-supervision.js";
import {
  isBoundedText,
  isExactResultValidForCall,
  isOptionalBoundedText,
  isSettledObservedEffectCompatible,
  isValidCapabilityResultReferences,
} from "../reducer-primitives.js";

type CapabilitySettlement = Omit<RoleCapabilityBatchSettlement, "executionId">;

export function hasValidCapabilitySettlement(
  settlement: CapabilitySettlement,
  call: RoleCallFrame,
  execution: RoleCapabilityExecution,
  policy: RoleCallPolicy,
): boolean {
  if (!isBoundedText(settlement.summary, policy.limits.maxResultChars)) {
    return false;
  }
  if (
    !isOptionalBoundedText(
      settlement.referenceData,
      ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
    )
  ) {
    return false;
  }
  if (!isValidCapabilityResultReferences(settlement.references)) return false;
  if (!isExactResultValidForCall(call, settlement.exactResult)) return false;
  if (settlement.outcome !== "succeeded" && settlement.outcome !== "failed") {
    return false;
  }
  return isSettledObservedEffectCompatible({
    declaredEffect: execution.declaredEffect,
    outcome: settlement.outcome,
    observedEffect: settlement.observedEffect,
  });
}

export function settleCapabilityExecutionRecord(
  execution: RoleCapabilityExecution,
  settlement: CapabilitySettlement,
): RoleCapabilityExecution {
  return {
    ...execution,
    status: "settled",
    outcome: settlement.outcome,
    outcomeFingerprint: settlement.outcomeFingerprint ?? null,
    observedEffect: settlement.observedEffect,
    summary: settlement.summary.trim(),
    ...(settlement.referenceData
      ? { referenceData: settlement.referenceData }
      : {}),
    ...(settlement.references && settlement.references.length > 0
      ? { references: Object.freeze([...settlement.references]) }
      : {}),
    exactResult: settlement.exactResult,
  };
}

export function advanceOperationSupervisionForCapabilitySettlement(
  current: RoleCallState["operationSupervision"],
  execution: RoleCapabilityExecution,
  settlement: CapabilitySettlement,
): RoleCallState["operationSupervision"] {
  return advanceRoleOperationSupervisionSettlement(current, {
    capabilityId: execution.capabilityId,
    ...(execution.actionFingerprint
      ? { actionFingerprint: execution.actionFingerprint }
      : {}),
    outcome: settlement.outcome,
    ...(settlement.outcomeFingerprint
      ? { outcomeFingerprint: settlement.outcomeFingerprint }
      : {}),
    observedEffect: settlement.observedEffect,
    originExecutionId: execution.executionId,
  });
}
