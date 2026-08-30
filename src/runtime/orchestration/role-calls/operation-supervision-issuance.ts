import type { RoleCallCommitEffect, RoleCallState } from "./contracts.js";
import {
  isSameRoleOperationIdentity,
  type RoleOperationSupervisionEntry,
  type RoleOperationSupervisionInterventionRecord,
} from "./operation-supervision.js";

const issuedInterventionRequestIds = new WeakMap<
  RoleOperationSupervisionInterventionRecord,
  string
>();

export function issueCanonicalRoleOperationSupervisionTransition(input: {
  before: RoleCallState;
  after: RoleCallState;
  effect: RoleCallCommitEffect;
}): boolean {
  if (input.effect.type === "operation_supervision_intervened") {
    const intervention = findCanonicalInterventionRecord({
      before: input.before,
      after: input.after,
      effect: input.effect,
    });
    if (!intervention) return false;
    issuedInterventionRequestIds.set(intervention, input.before.requestId);
    return true;
  }
  if (
    input.effect.type === "capability_execution_settled" ||
    input.effect.type === "capability_batch_settled"
  ) {
    return true;
  }
  return input.after.operationSupervision === input.before.operationSupervision;
}

export function isIssuedRoleOperationSupervisionInterventionForRequest(input: {
  requestId: string;
  intervention: RoleOperationSupervisionInterventionRecord;
}): boolean {
  return (
    issuedInterventionRequestIds.get(input.intervention) === input.requestId
  );
}

function findCanonicalInterventionRecord(input: {
  before: RoleCallState;
  after: RoleCallState;
  effect: Extract<
    RoleCallCommitEffect,
    { type: "operation_supervision_intervened" }
  >;
}): RoleOperationSupervisionInterventionRecord | undefined {
  const before = input.before.operationSupervision;
  const after = input.after.operationSupervision;
  const effect = input.effect;
  const entryIndex = before.entries.findIndex((entry) =>
    isSameRoleOperationIdentity(entry, effect),
  );
  if (
    after === before ||
    entryIndex < 0 ||
    after.entries.length !== before.entries.length ||
    after.interventions.length !== before.interventions.length + 1 ||
    hasChangedUnrelatedEntry(before.entries, after.entries, entryIndex) ||
    !before.interventions.every(
      (intervention, index) => after.interventions[index] === intervention,
    )
  ) {
    return undefined;
  }

  const warning = before.entries[entryIndex];
  const intervened = after.entries[entryIndex];
  const intervention = after.interventions[after.interventions.length - 1];
  if (
    warning?.stage !== "warning" ||
    intervened?.stage !== "intervened" ||
    !intervention ||
    !hasMatchingInterventionEvidence(warning, effect) ||
    !hasMatchingInterventionEvidence(intervened, effect) ||
    !hasMatchingInterventionEvidence(intervention, effect) ||
    !hasMatchingInterventionAttempt(intervened, effect) ||
    !hasMatchingInterventionAttempt(intervention, effect)
  ) {
    return undefined;
  }
  return intervention;
}

function hasChangedUnrelatedEntry(
  before: readonly RoleOperationSupervisionEntry[],
  after: readonly RoleOperationSupervisionEntry[],
  changedIndex: number,
): boolean {
  return before.some(
    (entry, index) => index !== changedIndex && after[index] !== entry,
  );
}

type InterventionEffect = Extract<
  RoleCallCommitEffect,
  { type: "operation_supervision_intervened" }
>;

function hasMatchingInterventionEvidence(
  evidence:
    | RoleOperationSupervisionEntry
    | RoleOperationSupervisionInterventionRecord,
  effect: InterventionEffect,
): boolean {
  return (
    isSameRoleOperationIdentity(evidence, effect) &&
    evidence.priorOutcome === effect.priorOutcome &&
    evidence.outcomeFingerprint === effect.outcomeFingerprint &&
    evidence.originExecutionId === effect.originExecutionId &&
    evidence.matchingOutcomeCount === effect.matchingOutcomeCount
  );
}

function hasMatchingInterventionAttempt(
  intervention:
    | Extract<RoleOperationSupervisionEntry, { stage: "intervened" }>
    | RoleOperationSupervisionInterventionRecord,
  effect: InterventionEffect,
): boolean {
  return (
    intervention.interventionCount === effect.interventionCount &&
    intervention.interventionCallId === effect.callId &&
    intervention.interventionInvocationAttempt === effect.invocationAttempt
  );
}
