import { createHash } from "node:crypto";

import { exactKeys, isRecord } from "../../validation/strict-record.js";
import {
  isRoleCapabilityId,
  ROLE_CAPABILITY_INVOCATION_CONTROLS_JSON_MAX_LENGTH,
  ROLE_CAPABILITY_SELECTION_INVOCATION_LIMIT_MAX,
} from "./contracts.js";
import { normalizeEstablishedRoleCallWorkingDirectory } from "./working-directory.js";

export const ROLE_CAPABILITY_SELECTION_SUPERVISION_FINGERPRINT_PATTERN =
  /^sha256:[a-f0-9]{64}$/;
export const ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_WARNING_COUNT =
  2 as const;
export const ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_INTERVENTION_COUNT =
  3 as const;
export const ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_LIMIT = 4 as const;
export const ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_WARNING_COUNT =
  6 as const;
export const ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_INTERVENTION_COUNT =
  7 as const;
export const ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_LIMIT = 8 as const;
export const ROLE_CAPABILITY_SELECTION_SUPERVISION_RECORD_LIMIT =
  ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_LIMIT - 1;

export type RoleCapabilitySelectionSupervisionFingerprint = string;
export type RoleCapabilitySelectionSupervisionStage =
  | "tracking"
  | "warning"
  | "intervened";
export type RoleCapabilitySelectionSupervisionTrigger =
  | "repeat_identity"
  | "total_budget"
  | "repeat_and_total";

export type RoleCapabilitySelectionSupervisionSelection = Readonly<{
  action: "invoke_capability" | "invoke_capabilities";
  invocations: readonly Readonly<{
    capabilityId: string;
    selectionControlsJson: string;
    intent?: string;
  }>[];
  workingDirectory?: string | null;
  activeCapabilityCatalogGroupIds?: readonly string[];
}>;

export type RoleCapabilitySelectionSupervisionEpoch = Readonly<{
  callId: string;
  steeringVersion: number;
}>;

export type RoleCapabilitySelectionSupervisionRecord = Readonly<{
  invocationAttempt: number;
  receiptFingerprint: string;
  supervisionFingerprint: RoleCapabilitySelectionSupervisionFingerprint;
  identityCount: number;
  totalCount: number;
  stage: RoleCapabilitySelectionSupervisionStage;
  trigger: RoleCapabilitySelectionSupervisionTrigger;
}>;

export type RoleCapabilitySelectionSupervisionState = Readonly<{
  epoch: RoleCapabilitySelectionSupervisionEpoch | null;
  records: readonly RoleCapabilitySelectionSupervisionRecord[];
}>;

type RoleCapabilitySelectionSupervisionAssessmentBase = Readonly<{
  supervisionFingerprint: RoleCapabilitySelectionSupervisionFingerprint;
  identityCount: number;
  totalCount: number;
  trigger: RoleCapabilitySelectionSupervisionTrigger;
}>;

export type RoleCapabilitySelectionSupervisionAssessment =
  | (RoleCapabilitySelectionSupervisionAssessmentBase &
      Readonly<{
        disposition: RoleCapabilitySelectionSupervisionStage;
        state: RoleCapabilitySelectionSupervisionState;
        record: RoleCapabilitySelectionSupervisionRecord;
      }>)
  | (RoleCapabilitySelectionSupervisionAssessmentBase &
      Readonly<{
        disposition: "reject";
        issueCode: "capability_selection_supervision_limit_exceeded";
        attemptedRecord: Readonly<{
          invocationAttempt: number;
          receiptFingerprint: string;
          supervisionFingerprint: RoleCapabilitySelectionSupervisionFingerprint;
        }>;
      }>);

export function createInitialRoleCapabilitySelectionSupervisionState(): RoleCapabilitySelectionSupervisionState {
  return Object.freeze({
    epoch: null,
    records: Object.freeze([]),
  });
}

export function createRoleCapabilitySelectionSupervisionFingerprint(input: {
  steeringVersion: number;
  selection: RoleCapabilitySelectionSupervisionSelection;
}): RoleCapabilitySelectionSupervisionFingerprint {
  if (!isNonNegativeSafeInteger(input.steeringVersion)) {
    throw new Error(
      "role_capability_selection_supervision_steering_version_invalid",
    );
  }
  const canonicalSelection = canonicalizeSupervisedSelection(input.selection);
  if (!canonicalSelection) {
    throw new Error("role_capability_selection_supervision_selection_invalid");
  }
  const canonical = JSON.stringify({
    steeringVersion: input.steeringVersion,
    ...canonicalSelection,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function assessRoleCapabilitySelectionSupervisionReconsideration(input: {
  state: RoleCapabilitySelectionSupervisionState;
  callId: string;
  invocationAttempt: number;
  steeringVersion: number;
  receiptFingerprint: string;
  selection: RoleCapabilitySelectionSupervisionSelection;
}): RoleCapabilitySelectionSupervisionAssessment {
  if (!isRoleCapabilitySelectionSupervisionState(input.state)) {
    throw new Error("role_capability_selection_supervision_state_invalid");
  }
  if (!isBoundedCallId(input.callId)) {
    throw new Error("role_capability_selection_supervision_call_id_invalid");
  }
  if (
    !Number.isSafeInteger(input.invocationAttempt) ||
    input.invocationAttempt < 1
  ) {
    throw new Error(
      "role_capability_selection_supervision_invocation_attempt_invalid",
    );
  }
  if (
    !isRoleCapabilitySelectionSupervisionFingerprint(input.receiptFingerprint)
  ) {
    throw new Error(
      "role_capability_selection_supervision_receipt_fingerprint_invalid",
    );
  }

  const epochState = resolveAssessmentEpoch(input);
  const previousRecord = epochState.records.at(-1);
  if (
    previousRecord &&
    input.invocationAttempt <= previousRecord.invocationAttempt
  ) {
    throw new Error(
      "role_capability_selection_supervision_invocation_order_invalid",
    );
  }
  const supervisionFingerprint =
    createRoleCapabilitySelectionSupervisionFingerprint({
      steeringVersion: input.steeringVersion,
      selection: input.selection,
    });
  const identityCount =
    epochState.records.filter(
      (record) => record.supervisionFingerprint === supervisionFingerprint,
    ).length + 1;
  const totalCount = epochState.records.length + 1;
  const stageDecision = strongestStageDecision(identityCount, totalCount);
  const attemptedRecord = Object.freeze({
    invocationAttempt: input.invocationAttempt,
    receiptFingerprint: input.receiptFingerprint,
    supervisionFingerprint,
  });

  if (stageDecision.stage === "reject") {
    return Object.freeze({
      disposition: "reject",
      issueCode: "capability_selection_supervision_limit_exceeded",
      attemptedRecord,
      supervisionFingerprint,
      identityCount,
      totalCount,
      trigger: stageDecision.trigger,
    });
  }

  const record = Object.freeze({
    ...attemptedRecord,
    identityCount,
    totalCount,
    stage: stageDecision.stage,
    trigger: stageDecision.trigger,
  });
  const state = Object.freeze({
    epoch: epochState.epoch,
    records: Object.freeze([...epochState.records, record]),
  });
  return Object.freeze({
    disposition: stageDecision.stage,
    state,
    record,
    supervisionFingerprint,
    identityCount,
    totalCount,
    trigger: stageDecision.trigger,
  });
}

export function resetRoleCapabilitySelectionSupervisionState(): RoleCapabilitySelectionSupervisionState {
  return createInitialRoleCapabilitySelectionSupervisionState();
}

export function replayRoleCapabilitySelectionSupervisionRecords(input: {
  epoch: RoleCapabilitySelectionSupervisionEpoch | null;
  records: readonly RoleCapabilitySelectionSupervisionRecord[];
}): RoleCapabilitySelectionSupervisionState | undefined {
  if (input.epoch === null) {
    return input.records.length === 0
      ? createInitialRoleCapabilitySelectionSupervisionState()
      : undefined;
  }
  if (!isRoleCapabilitySelectionSupervisionEpoch(input.epoch)) return undefined;
  if (
    input.records.length < 1 ||
    input.records.length > ROLE_CAPABILITY_SELECTION_SUPERVISION_RECORD_LIMIT
  ) {
    return undefined;
  }

  const replayed: RoleCapabilitySelectionSupervisionRecord[] = [];
  for (const candidate of input.records) {
    if (!isRoleCapabilitySelectionSupervisionRecord(candidate))
      return undefined;
    const previous = replayed.at(-1);
    if (previous && candidate.invocationAttempt <= previous.invocationAttempt) {
      return undefined;
    }
    const identityCount =
      replayed.filter(
        (record) =>
          record.supervisionFingerprint === candidate.supervisionFingerprint,
      ).length + 1;
    const decision = strongestStageDecision(identityCount, replayed.length + 1);
    if (
      decision.stage === "reject" ||
      decision.stage !== candidate.stage ||
      candidate.identityCount !== identityCount ||
      candidate.totalCount !== replayed.length + 1 ||
      candidate.trigger !== decision.trigger
    ) {
      return undefined;
    }
    replayed.push(Object.freeze({ ...candidate }));
  }
  return Object.freeze({
    epoch: Object.freeze({ ...input.epoch }),
    records: Object.freeze(replayed),
  });
}

export function isRoleCapabilitySelectionSupervisionState(
  input: unknown,
): input is RoleCapabilitySelectionSupervisionState {
  if (
    !isRecord(input) ||
    !exactKeys(input, ["epoch", "records"]) ||
    !Array.isArray(input.records)
  ) {
    return false;
  }
  return (
    replayRoleCapabilitySelectionSupervisionRecords({
      epoch: input.epoch as RoleCapabilitySelectionSupervisionEpoch | null,
      records:
        input.records as unknown as readonly RoleCapabilitySelectionSupervisionRecord[],
    }) !== undefined
  );
}

export function isRoleCapabilitySelectionSupervisionFingerprint(
  input: unknown,
): input is RoleCapabilitySelectionSupervisionFingerprint {
  return (
    typeof input === "string" &&
    ROLE_CAPABILITY_SELECTION_SUPERVISION_FINGERPRINT_PATTERN.test(input)
  );
}

function resolveAssessmentEpoch(input: {
  state: RoleCapabilitySelectionSupervisionState;
  callId: string;
  steeringVersion: number;
}): RoleCapabilitySelectionSupervisionState & {
  epoch: RoleCapabilitySelectionSupervisionEpoch;
} {
  if (!isNonNegativeSafeInteger(input.steeringVersion)) {
    throw new Error(
      "role_capability_selection_supervision_steering_version_invalid",
    );
  }
  const epoch = input.state.epoch;
  if (!epoch) {
    return createEpochState(input.callId, input.steeringVersion);
  }
  if (epoch.callId !== input.callId) {
    throw new Error("role_capability_selection_supervision_epoch_call_invalid");
  }
  if (input.steeringVersion < epoch.steeringVersion) {
    throw new Error("role_capability_selection_supervision_steering_stale");
  }
  return input.steeringVersion === epoch.steeringVersion
    ? Object.freeze({ epoch, records: input.state.records })
    : createEpochState(input.callId, input.steeringVersion);
}

function createEpochState(
  callId: string,
  steeringVersion: number,
): RoleCapabilitySelectionSupervisionState & {
  epoch: RoleCapabilitySelectionSupervisionEpoch;
} {
  return Object.freeze({
    epoch: Object.freeze({ callId, steeringVersion }),
    records: Object.freeze([]),
  });
}

function strongestStageDecision(
  identityCount: number,
  totalCount: number,
): Readonly<{
  stage: RoleCapabilitySelectionSupervisionStage | "reject";
  trigger: RoleCapabilitySelectionSupervisionTrigger;
}> {
  const repeatStage = repeatStageForCount(identityCount);
  const totalStage = totalStageForCount(totalCount);
  const repeatRank = stageRank(repeatStage);
  const totalRank = stageRank(totalStage);
  const trigger =
    totalCount >= ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_WARNING_COUNT &&
    repeatRank === totalRank
      ? "repeat_and_total"
      : totalRank > repeatRank
        ? "total_budget"
        : "repeat_identity";
  return Object.freeze({
    stage: repeatRank >= totalRank ? repeatStage : totalStage,
    trigger,
  });
}

function repeatStageForCount(
  count: number,
): RoleCapabilitySelectionSupervisionStage | "reject" {
  if (count >= ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_LIMIT) {
    return "reject";
  }
  if (
    count >= ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_INTERVENTION_COUNT
  ) {
    return "intervened";
  }
  return count >= ROLE_CAPABILITY_SELECTION_SUPERVISION_REPEAT_WARNING_COUNT
    ? "warning"
    : "tracking";
}

function totalStageForCount(
  count: number,
): RoleCapabilitySelectionSupervisionStage | "reject" {
  if (count >= ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_LIMIT) {
    return "reject";
  }
  if (count >= ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_INTERVENTION_COUNT) {
    return "intervened";
  }
  return count >= ROLE_CAPABILITY_SELECTION_SUPERVISION_TOTAL_WARNING_COUNT
    ? "warning"
    : "tracking";
}

function stageRank(
  stage: RoleCapabilitySelectionSupervisionStage | "reject",
): number {
  return stage === "tracking"
    ? 0
    : stage === "warning"
      ? 1
      : stage === "intervened"
        ? 2
        : 3;
}

function canonicalizeSupervisedSelection(
  selection: RoleCapabilitySelectionSupervisionSelection,
):
  | Readonly<{
      selectionKind: "single" | "batch";
      workingDirectory: string;
      invocations: readonly Readonly<{
        capabilityId: string;
        selectionControlsJson: string;
      }>[];
    }>
  | undefined {
  if (!isRecord(selection) || !Array.isArray(selection.invocations)) {
    return undefined;
  }
  const selectionKind =
    selection.action === "invoke_capability"
      ? "single"
      : selection.action === "invoke_capabilities"
        ? "batch"
        : undefined;
  if (
    !selectionKind ||
    selection.invocations.length < 1 ||
    selection.invocations.length >
      ROLE_CAPABILITY_SELECTION_INVOCATION_LIMIT_MAX ||
    (selectionKind === "single"
      ? selection.invocations.length !== 1
      : selection.invocations.length < 2)
  ) {
    return undefined;
  }
  const workingDirectory = normalizeEffectiveWorkingDirectory(
    selection.workingDirectory,
  );
  if (!workingDirectory) return undefined;

  const invocations = selection.invocations.map((invocation) => {
    if (!isRecord(invocation) || !isRoleCapabilityId(invocation.capabilityId)) {
      return undefined;
    }
    const selectionControlsJson = canonicalizeControlsJson(
      invocation.selectionControlsJson,
    );
    return selectionControlsJson === undefined
      ? undefined
      : Object.freeze({
          capabilityId: invocation.capabilityId,
          selectionControlsJson,
        });
  });
  if (invocations.some((invocation) => invocation === undefined)) {
    return undefined;
  }
  const canonicalInvocations = invocations as Readonly<{
    capabilityId: string;
    selectionControlsJson: string;
  }>[];
  return Object.freeze({
    selectionKind,
    workingDirectory,
    invocations: Object.freeze(
      selectionKind === "batch"
        ? [...canonicalInvocations].sort(compareCanonicalInvocation)
        : canonicalInvocations,
    ),
  });
}

function normalizeEffectiveWorkingDirectory(
  input: unknown,
): string | undefined {
  return input === undefined || input === null
    ? "."
    : normalizeEstablishedRoleCallWorkingDirectory(input);
}

function canonicalizeControlsJson(input: unknown): string | undefined {
  if (
    typeof input !== "string" ||
    input.length < 2 ||
    input.length > ROLE_CAPABILITY_INVOCATION_CONTROLS_JSON_MAX_LENGTH
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed)
      ? JSON.stringify(canonicalizeJsonValue(parsed))
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalizeJsonValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalizeJsonValue);
  if (!isRecord(input)) return input;
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, canonicalizeJsonValue(input[key])]),
  );
}

function compareCanonicalInvocation(
  left: Readonly<{ capabilityId: string; selectionControlsJson: string }>,
  right: Readonly<{ capabilityId: string; selectionControlsJson: string }>,
): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function isRoleCapabilitySelectionSupervisionEpoch(
  input: unknown,
): input is RoleCapabilitySelectionSupervisionEpoch {
  return (
    isRecord(input) &&
    exactKeys(input, ["callId", "steeringVersion"]) &&
    isBoundedCallId(input.callId) &&
    isNonNegativeSafeInteger(input.steeringVersion)
  );
}

function isRoleCapabilitySelectionSupervisionRecord(
  input: unknown,
): input is RoleCapabilitySelectionSupervisionRecord {
  return (
    isRecord(input) &&
    exactKeys(input, [
      "invocationAttempt",
      "receiptFingerprint",
      "supervisionFingerprint",
      "identityCount",
      "totalCount",
      "stage",
      "trigger",
    ]) &&
    Number.isSafeInteger(input.invocationAttempt) &&
    (input.invocationAttempt as number) >= 1 &&
    isRoleCapabilitySelectionSupervisionFingerprint(input.receiptFingerprint) &&
    isRoleCapabilitySelectionSupervisionFingerprint(
      input.supervisionFingerprint,
    ) &&
    Number.isSafeInteger(input.identityCount) &&
    (input.identityCount as number) >= 1 &&
    Number.isSafeInteger(input.totalCount) &&
    (input.totalCount as number) >= 1 &&
    (input.stage === "tracking" ||
      input.stage === "warning" ||
      input.stage === "intervened") &&
    (input.trigger === "repeat_identity" ||
      input.trigger === "total_budget" ||
      input.trigger === "repeat_and_total")
  );
}

function isBoundedCallId(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= 256;
}

function isNonNegativeSafeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}
