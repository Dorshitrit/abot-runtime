import {
  createRoleCapabilitySelectionSupervisionFingerprint,
  isRoleCapabilitySelectionSupervisionState,
  type RoleCapabilitySelectionSupervisionRecord,
} from "./capability-selection-supervision.js";
import { isIssuedRoleCapabilitySelectionSupervisionState } from "./capability-selection-supervision-issuance.js";
import type {
  ExecutionPolicyAuthoritySnapshot,
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallState,
} from "./contracts.js";
import { hasSettledMemoryRecallActivationRange } from "./memory-recall-state-validation.js";
import { findCall } from "./reducer-primitives.js";

export function isValidRoleCapabilitySelectionSupervision(
  state: RoleCallState,
  policy: RoleCallPolicy,
  hasCapabilityAuthority: (
    authority: ExecutionPolicyAuthoritySnapshot,
    state: RoleCallState,
    call: RoleCallFrame | undefined,
  ) => call is RoleCallFrame,
): boolean {
  const supervision = state.capabilitySelectionSupervision;
  if (!isRoleCapabilitySelectionSupervisionState(supervision)) return false;
  if (supervision.epoch === null) return supervision.records.length === 0;
  if (!isIssuedRoleCapabilitySelectionSupervisionState({ state })) return false;
  if (state.phase !== "running" || supervision.records.length < 1) return false;
  const call = findCall(state, supervision.epoch.callId);
  if (!hasCapabilityAuthority(policy.authority, state, call)) return false;
  if (state.activeCallId !== call.callId) return false;
  if (!isSelectionSupervisionTurnOwner(call)) return false;
  const lastRecord = supervision.records.at(-1);
  const reconsideration = call.lastCapabilitySelectionReconsideration;
  if (!lastRecord || !reconsideration) return false;
  if (supervision.epoch.steeringVersion !== reconsideration.steeringVersion)
    return false;
  if (!isSelectionReceiptBoundToLatestRecord(call, lastRecord)) return false;
  if (
    !hasSettledMemoryRecallActivationRange(
      state,
      call.callId,
      lastRecord.invocationAttempt + 1,
      call.activationCount,
    )
  )
    return false;
  return supervision.records.every((record, index, records) =>
    hasContiguousSupervisionActivation(state, call, record, records[index - 1]),
  );
}

function isSelectionSupervisionTurnOwner(call: RoleCallFrame): boolean {
  return call.status === "active" || call.status === "waiting_for_memory";
}

function isSelectionReceiptBoundToLatestRecord(
  call: RoleCallFrame,
  lastRecord: RoleCapabilitySelectionSupervisionRecord,
): boolean {
  const reconsideration = call.lastCapabilitySelectionReconsideration;
  if (!reconsideration) return false;
  if (lastRecord.invocationAttempt !== reconsideration.invocationAttempt)
    return false;
  if (lastRecord.receiptFingerprint !== reconsideration.fingerprint)
    return false;
  try {
    const fingerprint = createRoleCapabilitySelectionSupervisionFingerprint({
      steeringVersion: reconsideration.steeringVersion,
      selection: reconsideration.selection,
    });
    return lastRecord.supervisionFingerprint === fingerprint;
  } catch {
    return false;
  }
}

function hasContiguousSupervisionActivation(
  state: RoleCallState,
  call: RoleCallFrame,
  record: RoleCapabilitySelectionSupervisionRecord,
  previous: RoleCapabilitySelectionSupervisionRecord | undefined,
): boolean {
  if (record.invocationAttempt >= call.activationCount) return false;
  if (!previous) return true;
  return hasSettledMemoryRecallActivationRange(
    state,
    call.callId,
    previous.invocationAttempt + 1,
    record.invocationAttempt,
  );
}
