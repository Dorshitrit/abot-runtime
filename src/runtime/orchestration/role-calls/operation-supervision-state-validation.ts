import {
  advanceRoleOperationSupervisionSettlement,
  createInitialRoleOperationSupervisionState,
  findRoleOperationSupervisionEntry,
  isRoleOperationFingerprint,
  isRoleOperationOutcomeFingerprintForOutcome,
  ROLE_OPERATION_INTERVENTION_LIMIT,
  ROLE_OPERATION_REPEAT_EXECUTION_LIMIT,
  type RoleOperationSupervisionEntry,
  type RoleOperationSupervisionInterventionRecord,
  type RoleOperationSupervisionSettlement,
  type RoleOperationSupervisionState,
} from "./operation-supervision.js";
import { isRoleCapabilityId } from "./contracts.js";

export function isRoleOperationSupervisionSettlementHistoryValid(
  settlements: readonly RoleOperationSupervisionSettlement[],
): boolean {
  let state = createInitialRoleOperationSupervisionState();
  for (const settlement of settlements) {
    const fingerprint = settlement.actionFingerprint;
    const outcomeFingerprint = settlement.outcomeFingerprint;
    if (fingerprint && outcomeFingerprint) {
      const existing = findRoleOperationSupervisionEntry(state, {
        capabilityId: settlement.capabilityId,
        actionFingerprint: fingerprint,
      });
      if (
        existing?.stage === "warning" &&
        existing.outcomeFingerprint === outcomeFingerprint
      ) {
        return false;
      }
    }
    state = advanceRoleOperationSupervisionSettlement(state, settlement);
  }
  return true;
}

export function isRoleOperationSupervisionState(
  value: unknown,
): value is RoleOperationSupervisionState {
  if (!isRecord(value) || !hasExactKeys(value, ["entries", "interventions"])) {
    return false;
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.interventions)) {
    return false;
  }
  const fingerprintsByCapability = new Map<string, Set<string>>();
  for (const entry of value.entries) {
    if (!isRoleOperationSupervisionEntry(entry)) return false;
    if (!registerUniqueOperationIdentity(fingerprintsByCapability, entry)) {
      return false;
    }
  }

  const interventionFingerprintsByCapability = new Map<string, Set<string>>();
  const latestAttemptByCall = new Map<string, number>();
  for (const intervention of value.interventions) {
    if (!isRoleOperationSupervisionInterventionRecord(intervention)) {
      return false;
    }
    if (
      !registerUniqueOperationIdentity(
        interventionFingerprintsByCapability,
        intervention,
      )
    ) {
      return false;
    }
    const latestAttempt = latestAttemptByCall.get(
      intervention.interventionCallId,
    );
    if (
      latestAttempt !== undefined &&
      intervention.interventionInvocationAttempt <= latestAttempt
    ) {
      return false;
    }
    latestAttemptByCall.set(
      intervention.interventionCallId,
      intervention.interventionInvocationAttempt,
    );
  }
  return true;
}

function isRoleOperationSupervisionEntry(
  value: unknown,
): value is RoleOperationSupervisionEntry {
  if (!isRecord(value) || !isBaseEntry(value)) return false;
  if (value.stage === "tracking") {
    return (
      hasExactKeys(value, [
        "stage",
        "capabilityId",
        "actionFingerprint",
        "priorOutcome",
        "outcomeFingerprint",
        "originExecutionId",
        "matchingOutcomeCount",
      ]) && value.matchingOutcomeCount === 1
    );
  }
  if (value.stage === "warning") {
    return (
      hasExactKeys(value, [
        "stage",
        "capabilityId",
        "actionFingerprint",
        "priorOutcome",
        "outcomeFingerprint",
        "originExecutionId",
        "matchingOutcomeCount",
      ]) && value.matchingOutcomeCount === ROLE_OPERATION_REPEAT_EXECUTION_LIMIT
    );
  }
  return (
    value.stage === "intervened" &&
    hasExactKeys(value, [
      "stage",
      "capabilityId",
      "actionFingerprint",
      "priorOutcome",
      "outcomeFingerprint",
      "originExecutionId",
      "matchingOutcomeCount",
      "interventionCount",
      "interventionCallId",
      "interventionInvocationAttempt",
    ]) &&
    value.matchingOutcomeCount === ROLE_OPERATION_REPEAT_EXECUTION_LIMIT &&
    value.interventionCount === ROLE_OPERATION_INTERVENTION_LIMIT &&
    isBoundedIdentifier(value.interventionCallId) &&
    Number.isSafeInteger(value.interventionInvocationAttempt) &&
    (value.interventionInvocationAttempt as number) >= 1
  );
}

function isRoleOperationSupervisionInterventionRecord(
  value: unknown,
): value is RoleOperationSupervisionInterventionRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "capabilityId",
      "actionFingerprint",
      "priorOutcome",
      "outcomeFingerprint",
      "originExecutionId",
      "matchingOutcomeCount",
      "interventionCount",
      "interventionCallId",
      "interventionInvocationAttempt",
    ]) &&
    isSupervisionEvidence(value) &&
    value.matchingOutcomeCount === ROLE_OPERATION_REPEAT_EXECUTION_LIMIT &&
    value.interventionCount === ROLE_OPERATION_INTERVENTION_LIMIT &&
    isBoundedIdentifier(value.interventionCallId) &&
    Number.isSafeInteger(value.interventionInvocationAttempt) &&
    (value.interventionInvocationAttempt as number) >= 1
  );
}

function isBaseEntry(value: Record<string, unknown>): boolean {
  return (
    (value.stage === "tracking" ||
      value.stage === "warning" ||
      value.stage === "intervened") &&
    isSupervisionEvidence(value)
  );
}

function isSupervisionEvidence(value: Record<string, unknown>): boolean {
  return (
    isRoleCapabilityId(value.capabilityId) &&
    isRoleOperationFingerprint(value.actionFingerprint) &&
    (value.priorOutcome === "succeeded" || value.priorOutcome === "failed") &&
    isRoleOperationOutcomeFingerprintForOutcome(
      value.outcomeFingerprint,
      value.priorOutcome,
    ) &&
    isBoundedIdentifier(value.originExecutionId)
  );
}

function registerUniqueOperationIdentity(
  fingerprintsByCapability: Map<string, Set<string>>,
  identity: Readonly<{ capabilityId: string; actionFingerprint: string }>,
): boolean {
  const fingerprints =
    fingerprintsByCapability.get(identity.capabilityId) ?? new Set<string>();
  if (fingerprints.has(identity.actionFingerprint)) return false;
  fingerprints.add(identity.actionFingerprint);
  fingerprintsByCapability.set(identity.capabilityId, fingerprints);
  return true;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
