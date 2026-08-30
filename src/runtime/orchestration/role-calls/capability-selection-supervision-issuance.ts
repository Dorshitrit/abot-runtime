import type { RoleCapabilitySelectionSupervisionRecord } from "./capability-selection-supervision.js";
import type { RoleCallCommitEffect, RoleCallState } from "./contracts.js";

declare const roleCapabilitySelectionSupervisionIssuanceAuthorityBrand: unique symbol;

export type RoleCapabilitySelectionSupervisionIssuanceAuthority = Readonly<{
  [roleCapabilitySelectionSupervisionIssuanceAuthorityBrand]: true;
}>;

type IssuedStateMetadata = Readonly<{
  authority: RoleCapabilitySelectionSupervisionIssuanceAuthority;
  lastRecord: RoleCapabilitySelectionSupervisionRecord | null;
}>;

type IssuedRecordMetadata = Readonly<{
  authority: RoleCapabilitySelectionSupervisionIssuanceAuthority;
  requestId: string;
  callId: string;
  steeringVersion: number;
  recordIndex: number;
  previousRecord: RoleCapabilitySelectionSupervisionRecord | null;
}>;

const issuedStateMetadata = new WeakMap<RoleCallState, IssuedStateMetadata>();
const issuedRecordMetadata = new WeakMap<
  RoleCapabilitySelectionSupervisionRecord,
  IssuedRecordMetadata
>();

export function issueInitialRoleCapabilitySelectionSupervisionState(
  state: RoleCallState,
): boolean {
  if (!isInitialSupervisionState(state) || issuedStateMetadata.has(state)) {
    return false;
  }
  const authority = Object.freeze(
    {},
  ) as RoleCapabilitySelectionSupervisionIssuanceAuthority;
  issuedStateMetadata.set(
    state,
    Object.freeze({ authority, lastRecord: null }),
  );
  return true;
}

export function resolveRoleCapabilitySelectionSupervisionIssuanceAuthority(
  state: RoleCallState,
): RoleCapabilitySelectionSupervisionIssuanceAuthority | undefined {
  return issuedStateMetadata.get(state)?.authority;
}

export function issueCanonicalRoleCapabilitySelectionSupervisionTransition(
  input: Readonly<{
    before: RoleCallState;
    after: RoleCallState;
    effect: RoleCallCommitEffect;
  }>,
): boolean {
  const beforeMetadata = issuedStateMetadata.get(input.before);
  if (
    !beforeMetadata ||
    !isIssuedRoleCapabilitySelectionSupervisionState({
      state: input.before,
      authority: beforeMetadata.authority,
    })
  ) {
    return false;
  }

  if (input.effect.type === "capability_selection_reconsidered") {
    const record = findCanonicalAppendedRecord({
      before: input.before,
      after: input.after,
      effect: input.effect,
    });
    const epoch = input.after.capabilitySelectionSupervision.epoch;
    if (!record || !epoch || issuedRecordMetadata.has(record)) return false;
    const sameEpoch =
      input.before.capabilitySelectionSupervision.epoch?.callId ===
        epoch.callId &&
      input.before.capabilitySelectionSupervision.epoch.steeringVersion ===
        epoch.steeringVersion;
    const beforeEpoch = input.before.capabilitySelectionSupervision.epoch;
    if (
      !sameEpoch &&
      beforeEpoch &&
      (beforeEpoch.callId !== epoch.callId ||
        epoch.steeringVersion <= beforeEpoch.steeringVersion)
    ) {
      return false;
    }
    const previousRecord = sameEpoch
      ? (input.before.capabilitySelectionSupervision.records.at(-1) ?? null)
      : null;
    if (!canIssueState(input.after, beforeMetadata.authority, record)) {
      return false;
    }
    issuedRecordMetadata.set(
      record,
      Object.freeze({
        authority: beforeMetadata.authority,
        requestId: input.before.requestId,
        callId: epoch.callId,
        steeringVersion: epoch.steeringVersion,
        recordIndex:
          input.after.capabilitySelectionSupervision.records.length - 1,
        previousRecord,
      }),
    );
    return issueState(input.after, beforeMetadata.authority, record);
  }
  if (isCapabilitySelectionSupervisionResetEffect(input.effect)) {
    if (!isInitialSupervisionState(input.after)) return false;
    return issueState(input.after, beforeMetadata.authority, null);
  }
  if (
    input.after.capabilitySelectionSupervision !==
    input.before.capabilitySelectionSupervision
  ) {
    return false;
  }
  return issueState(
    input.after,
    beforeMetadata.authority,
    beforeMetadata.lastRecord,
  );
}

export function isIssuedRoleCapabilitySelectionSupervisionState(
  input: Readonly<{
    state: RoleCallState;
    authority?: RoleCapabilitySelectionSupervisionIssuanceAuthority;
  }>,
): boolean {
  const stateMetadata = issuedStateMetadata.get(input.state);
  if (
    !stateMetadata ||
    (input.authority !== undefined &&
      stateMetadata.authority !== input.authority)
  ) {
    return false;
  }
  const supervision = input.state.capabilitySelectionSupervision;
  if (supervision.epoch === null || supervision.records.length === 0) {
    return (
      supervision.epoch === null &&
      supervision.records.length === 0 &&
      stateMetadata.lastRecord === null
    );
  }

  let previousRecord: RoleCapabilitySelectionSupervisionRecord | null = null;
  for (const [recordIndex, record] of supervision.records.entries()) {
    const recordMetadata = issuedRecordMetadata.get(record);
    if (
      !recordMetadata ||
      recordMetadata.authority !== stateMetadata.authority ||
      recordMetadata.requestId !== input.state.requestId ||
      recordMetadata.callId !== supervision.epoch.callId ||
      recordMetadata.steeringVersion !== supervision.epoch.steeringVersion ||
      recordMetadata.recordIndex !== recordIndex ||
      recordMetadata.previousRecord !== previousRecord
    ) {
      return false;
    }
    previousRecord = record;
  }
  return stateMetadata.lastRecord === previousRecord;
}

function issueState(
  state: RoleCallState,
  authority: RoleCapabilitySelectionSupervisionIssuanceAuthority,
  lastRecord: RoleCapabilitySelectionSupervisionRecord | null,
): boolean {
  if (!canIssueState(state, authority, lastRecord)) return false;
  issuedStateMetadata.set(state, Object.freeze({ authority, lastRecord }));
  return true;
}

function canIssueState(
  state: RoleCallState,
  authority: RoleCapabilitySelectionSupervisionIssuanceAuthority,
  lastRecord: RoleCapabilitySelectionSupervisionRecord | null,
): boolean {
  const existing = issuedStateMetadata.get(state);
  return (
    !existing ||
    (existing.authority === authority && existing.lastRecord === lastRecord)
  );
}

function findCanonicalAppendedRecord(
  input: Readonly<{
    before: RoleCallState;
    after: RoleCallState;
    effect: Extract<
      RoleCallCommitEffect,
      { type: "capability_selection_reconsidered" }
    >;
  }>,
): RoleCapabilitySelectionSupervisionRecord | undefined {
  const before = input.before.capabilitySelectionSupervision;
  const after = input.after.capabilitySelectionSupervision;
  const reconsideration = input.after.calls.find(
    (call) => call.callId === input.effect.callId,
  )?.lastCapabilitySelectionReconsideration;
  const record = after.records.at(-1);
  if (
    after === before ||
    !after.epoch ||
    !reconsideration ||
    !record ||
    after.epoch.callId !== input.effect.callId ||
    after.epoch.steeringVersion !== reconsideration.steeringVersion ||
    record.invocationAttempt !== input.effect.invocationAttempt ||
    record.receiptFingerprint !== input.effect.fingerprint ||
    record.supervisionFingerprint !== input.effect.supervisionFingerprint ||
    record.stage !== input.effect.supervisionStage ||
    record.trigger !== input.effect.supervisionTrigger ||
    record.identityCount !== input.effect.matchingSelectionCount ||
    record.totalCount !== input.effect.totalReconsiderationCount
  ) {
    return undefined;
  }
  const sameEpoch =
    before.epoch?.callId === after.epoch.callId &&
    before.epoch.steeringVersion === after.epoch.steeringVersion;
  if (!sameEpoch) {
    return after.records.length === 1 ? record : undefined;
  }
  if (
    after.epoch !== before.epoch ||
    after.records.length !== before.records.length + 1 ||
    !before.records.every(
      (previousRecord, index) => after.records[index] === previousRecord,
    )
  ) {
    return undefined;
  }
  return record;
}

function isCapabilitySelectionSupervisionResetEffect(
  effect: RoleCallCommitEffect,
): boolean {
  return (
    effect.type === "root_response_committed" ||
    effect.type === "child_opened" ||
    effect.type === "child_returned" ||
    effect.type === "capability_execution_begun" ||
    effect.type === "capability_batch_begun" ||
    effect.type === "operation_supervision_intervened" ||
    effect.type === "capability_scope_updated" ||
    effect.type === "working_directory_established"
  );
}

function isInitialSupervisionState(state: RoleCallState): boolean {
  return (
    state.capabilitySelectionSupervision.epoch === null &&
    state.capabilitySelectionSupervision.records.length === 0
  );
}
