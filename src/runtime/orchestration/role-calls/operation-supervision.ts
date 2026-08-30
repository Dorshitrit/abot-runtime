import type {
  RoleCallCommitEffect,
  RoleCallLedgerCommitResult,
  RoleCallLedgerHead,
  RoleCapabilityObservedEffect,
} from "./contracts.js";

export const ROLE_OPERATION_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const ROLE_OPERATION_FAILURE_FINGERPRINT_PATTERN =
  /^sha256:[a-f0-9]{64}$/;
export const ROLE_OPERATION_REPEAT_EXECUTION_LIMIT = 2 as const;
export const ROLE_OPERATION_INTERVENTION_LIMIT = 1 as const;

export type RoleOperationFingerprint = string;
export type RoleOperationOutcome = "succeeded" | "failed";
export type RoleOperationOutcomeFingerprint = string;

export type RoleOperationIdentity = Readonly<{
  capabilityId: string;
  actionFingerprint: RoleOperationFingerprint;
}>;

type RoleOperationSupervisionEntryBase = RoleOperationIdentity &
  Readonly<{
    priorOutcome: RoleOperationOutcome;
    outcomeFingerprint: RoleOperationOutcomeFingerprint;
    originExecutionId: string;
  }>;

export type RoleOperationSupervisionInterventionRecord =
  RoleOperationSupervisionEntryBase &
    Readonly<{
      matchingOutcomeCount: typeof ROLE_OPERATION_REPEAT_EXECUTION_LIMIT;
      interventionCount: typeof ROLE_OPERATION_INTERVENTION_LIMIT;
      interventionCallId: string;
      interventionInvocationAttempt: number;
    }>;

export type RoleOperationSupervisionEntry =
  | (RoleOperationSupervisionEntryBase &
      Readonly<{
        stage: "tracking";
        matchingOutcomeCount: 1;
      }>)
  | (RoleOperationSupervisionEntryBase &
      Readonly<{
        stage: "warning";
        matchingOutcomeCount: typeof ROLE_OPERATION_REPEAT_EXECUTION_LIMIT;
      }>)
  | (RoleOperationSupervisionInterventionRecord &
      Readonly<{
        stage: "intervened";
      }>);

export type RoleOperationSupervisionState = Readonly<{
  entries: readonly RoleOperationSupervisionEntry[];
  interventions: readonly RoleOperationSupervisionInterventionRecord[];
}>;

export type RoleOperationSupervisionAttemptDecision =
  | Readonly<{ disposition: "execute" }>
  | Readonly<{
      disposition: "intervene";
      state: RoleOperationSupervisionState;
      entry: Extract<RoleOperationSupervisionEntry, { stage: "intervened" }>;
    }>
  | Readonly<{
      disposition: "reject";
      issueCode: "operation_supervision_limit_exceeded";
    }>;

export type RoleOperationSupervisionBatchAttemptDecision =
  | Readonly<{ disposition: "execute" }>
  | Readonly<{
      disposition: "intervene";
      entryIndex: number;
      state: RoleOperationSupervisionState;
      entry: Extract<RoleOperationSupervisionEntry, { stage: "intervened" }>;
    }>
  | Readonly<{
      disposition: "reject";
      issueCode: "operation_supervision_limit_exceeded";
    }>;

export type RoleOperationSupervisionSettlement = Readonly<{
  capabilityId: string;
  actionFingerprint?: RoleOperationFingerprint;
  outcome: RoleOperationOutcome;
  outcomeFingerprint?: RoleOperationOutcomeFingerprint;
  observedEffect: RoleCapabilityObservedEffect;
  originExecutionId: string;
}>;

export type RoleCallOperationSupervisionInterventionCommit = Readonly<{
  ok: true;
  status: "committed";
  previousHead: RoleCallLedgerHead;
  head: RoleCallLedgerHead;
  effect: Extract<
    RoleCallCommitEffect,
    { type: "operation_supervision_intervened" }
  >;
}>;

export function createInitialRoleOperationSupervisionState(): RoleOperationSupervisionState {
  return Object.freeze({
    entries: Object.freeze([]),
    interventions: Object.freeze([]),
  });
}

export function assessRoleOperationSupervisionAttempt(input: {
  state: RoleOperationSupervisionState;
  callId: string;
  invocationAttempt: number;
  capabilityId: string;
  actionFingerprint: RoleOperationFingerprint | undefined;
}): RoleOperationSupervisionAttemptDecision {
  if (!input.actionFingerprint) {
    return Object.freeze({ disposition: "execute" });
  }
  const entry = findRoleOperationSupervisionEntry(input.state, {
    capabilityId: input.capabilityId,
    actionFingerprint: input.actionFingerprint,
  });
  if (!entry || entry.stage === "tracking") {
    return Object.freeze({ disposition: "execute" });
  }
  if (entry.stage === "intervened") {
    return Object.freeze({
      disposition: "reject",
      issueCode: "operation_supervision_limit_exceeded",
    });
  }

  const intervention = Object.freeze({
    capabilityId: entry.capabilityId,
    actionFingerprint: entry.actionFingerprint,
    priorOutcome: entry.priorOutcome,
    outcomeFingerprint: entry.outcomeFingerprint,
    originExecutionId: entry.originExecutionId,
    matchingOutcomeCount: entry.matchingOutcomeCount,
    interventionCount: ROLE_OPERATION_INTERVENTION_LIMIT,
    interventionCallId: input.callId,
    interventionInvocationAttempt: input.invocationAttempt,
  });
  const intervenedState = advanceRoleOperationSupervisionIntervention(
    input.state,
    intervention,
  );
  if (!intervenedState) {
    throw new Error("role_operation_supervision_intervention_state_invalid");
  }
  const intervenedEntry = findRoleOperationSupervisionEntry(intervenedState, {
    capabilityId: entry.capabilityId,
    actionFingerprint: entry.actionFingerprint,
  });
  if (intervenedEntry?.stage !== "intervened") {
    throw new Error("role_operation_supervision_intervention_entry_missing");
  }
  return Object.freeze({
    disposition: "intervene",
    state: intervenedState,
    entry: intervenedEntry,
  });
}

export function assessRoleOperationSupervisionBatchAttempt(input: {
  state: RoleOperationSupervisionState;
  callId: string;
  invocationAttempt: number;
  attempts: readonly Readonly<{
    capabilityId: string;
    actionFingerprint?: RoleOperationFingerprint;
  }>[];
}): RoleOperationSupervisionBatchAttemptDecision {
  let intervention:
    | Extract<
        RoleOperationSupervisionBatchAttemptDecision,
        { disposition: "intervene" }
      >
    | undefined;
  for (
    let entryIndex = 0;
    entryIndex < input.attempts.length;
    entryIndex += 1
  ) {
    const attempt = input.attempts[entryIndex]!;
    const decision = assessRoleOperationSupervisionAttempt({
      state: input.state,
      callId: input.callId,
      invocationAttempt: input.invocationAttempt,
      capabilityId: attempt.capabilityId,
      actionFingerprint: attempt.actionFingerprint,
    });
    if (decision.disposition === "reject") return decision;
    if (decision.disposition === "intervene" && !intervention) {
      intervention = Object.freeze({
        ...decision,
        entryIndex,
      });
    }
  }
  return intervention ?? Object.freeze({ disposition: "execute" });
}

export function advanceRoleOperationSupervisionSettlement(
  current: RoleOperationSupervisionState,
  settlement: RoleOperationSupervisionSettlement,
): RoleOperationSupervisionState {
  if (isSuccessfulObservedMutation(settlement)) {
    return createInitialRoleOperationSupervisionState();
  }
  if (
    !settlement.actionFingerprint ||
    !settlement.outcomeFingerprint ||
    !isRoleOperationOutcomeFingerprintForOutcome(
      settlement.outcomeFingerprint,
      settlement.outcome,
    )
  ) {
    return current;
  }
  const trackedSettlement = Object.freeze({
    capabilityId: settlement.capabilityId,
    actionFingerprint: settlement.actionFingerprint,
    outcome: settlement.outcome,
    outcomeFingerprint: settlement.outcomeFingerprint,
    observedEffect: settlement.observedEffect,
    originExecutionId: settlement.originExecutionId,
  });
  const existing = findRoleOperationSupervisionEntry(
    current,
    trackedSettlement,
  );
  if (!existing) {
    return appendRoleOperationSupervisionEntry(
      current,
      createTrackingEntry(trackedSettlement),
    );
  }
  if (existing.stage === "intervened") return current;
  if (existing.outcomeFingerprint !== trackedSettlement.outcomeFingerprint) {
    return replaceRoleOperationSupervisionEntry(
      current,
      createTrackingEntry(trackedSettlement),
    );
  }
  return replaceRoleOperationSupervisionEntry(
    current,
    Object.freeze({
      stage: "warning" as const,
      capabilityId: trackedSettlement.capabilityId,
      actionFingerprint: trackedSettlement.actionFingerprint,
      priorOutcome: trackedSettlement.outcome,
      outcomeFingerprint: trackedSettlement.outcomeFingerprint,
      originExecutionId: trackedSettlement.originExecutionId,
      matchingOutcomeCount: ROLE_OPERATION_REPEAT_EXECUTION_LIMIT,
    }),
  );
}

export function isSuccessfulObservedMutation(
  input: Readonly<{
    outcome: unknown;
    observedEffect: unknown;
  }>,
): boolean {
  return input.outcome === "succeeded" && input.observedEffect === "mutation";
}

export function replayRoleOperationSupervisionSettlements(
  settlements: readonly RoleOperationSupervisionSettlement[],
): RoleOperationSupervisionState {
  return settlements.reduce<RoleOperationSupervisionState>(
    advanceRoleOperationSupervisionSettlement,
    createInitialRoleOperationSupervisionState(),
  );
}

export function replayRoleOperationSupervisionEvidence(input: {
  settlements: readonly RoleOperationSupervisionSettlement[];
  interventions: readonly RoleOperationSupervisionInterventionRecord[];
}): RoleOperationSupervisionState | undefined {
  let state = replayRoleOperationSupervisionSettlements(input.settlements);
  for (const intervention of input.interventions) {
    const next = advanceRoleOperationSupervisionIntervention(
      state,
      intervention,
    );
    if (!next) return undefined;
    state = next;
  }
  return state;
}

export function advanceRoleOperationSupervisionIntervention(
  current: RoleOperationSupervisionState,
  intervention: RoleOperationSupervisionInterventionRecord,
): RoleOperationSupervisionState | undefined {
  const warning = findRoleOperationSupervisionEntry(current, intervention);
  if (
    warning?.stage !== "warning" ||
    !isInterventionBoundToWarning(intervention, warning)
  ) {
    return undefined;
  }
  const intervenedEntry = Object.freeze({
    stage: "intervened" as const,
    ...intervention,
  });
  return Object.freeze({
    entries: Object.freeze(
      current.entries.map((entry) =>
        isSameRoleOperationIdentity(entry, intervenedEntry)
          ? intervenedEntry
          : entry,
      ),
    ),
    interventions: Object.freeze([...current.interventions, intervention]),
  });
}

export function findRoleOperationSupervisionEntry(
  state: RoleOperationSupervisionState,
  identity: RoleOperationIdentity,
): RoleOperationSupervisionEntry | undefined {
  return state.entries.find((entry) =>
    isSameRoleOperationIdentity(entry, identity),
  );
}

export function isSameRoleOperationIdentity(
  left: RoleOperationIdentity,
  right: RoleOperationIdentity,
): boolean {
  return (
    left.capabilityId === right.capabilityId &&
    left.actionFingerprint === right.actionFingerprint
  );
}

export function isRoleOperationFingerprint(
  value: unknown,
): value is RoleOperationFingerprint {
  return (
    typeof value === "string" && ROLE_OPERATION_FINGERPRINT_PATTERN.test(value)
  );
}

export function isRoleOperationOutcomeFingerprintForOutcome(
  value: unknown,
  outcome: RoleOperationOutcome,
): value is RoleOperationOutcomeFingerprint {
  return outcome === "succeeded"
    ? value === "succeeded"
    : typeof value === "string" &&
        ROLE_OPERATION_FAILURE_FINGERPRINT_PATTERN.test(value);
}

export function requireRoleCallOperationSupervisionInterventionCommit(
  commit: RoleCallLedgerCommitResult,
): RoleCallOperationSupervisionInterventionCommit {
  if (!commit.ok || commit.effect.type !== "operation_supervision_intervened") {
    throw new Error("role_operation_supervision_intervention_commit_invalid");
  }
  return commit as RoleCallOperationSupervisionInterventionCommit;
}

function createTrackingEntry(
  settlement: RoleOperationSupervisionSettlement &
    Readonly<{
      actionFingerprint: RoleOperationFingerprint;
      outcomeFingerprint: RoleOperationOutcomeFingerprint;
    }>,
): Extract<RoleOperationSupervisionEntry, { stage: "tracking" }> {
  return Object.freeze({
    stage: "tracking",
    capabilityId: settlement.capabilityId,
    actionFingerprint: settlement.actionFingerprint,
    priorOutcome: settlement.outcome,
    outcomeFingerprint: settlement.outcomeFingerprint,
    originExecutionId: settlement.originExecutionId,
    matchingOutcomeCount: 1,
  });
}

function appendRoleOperationSupervisionEntry(
  state: RoleOperationSupervisionState,
  entry: RoleOperationSupervisionEntry,
): RoleOperationSupervisionState {
  return Object.freeze({
    entries: Object.freeze([...state.entries, entry]),
    interventions: state.interventions,
  });
}

function replaceRoleOperationSupervisionEntry(
  state: RoleOperationSupervisionState,
  replacement: RoleOperationSupervisionEntry,
): RoleOperationSupervisionState {
  return Object.freeze({
    entries: Object.freeze(
      state.entries.map((entry) =>
        isSameRoleOperationIdentity(entry, replacement) ? replacement : entry,
      ),
    ),
    interventions: state.interventions,
  });
}

function isInterventionBoundToWarning(
  intervention: RoleOperationSupervisionInterventionRecord,
  warning: Extract<RoleOperationSupervisionEntry, { stage: "warning" }>,
): boolean {
  return (
    intervention.priorOutcome === warning.priorOutcome &&
    intervention.outcomeFingerprint === warning.outcomeFingerprint &&
    intervention.originExecutionId === warning.originExecutionId &&
    intervention.matchingOutcomeCount === warning.matchingOutcomeCount
  );
}
