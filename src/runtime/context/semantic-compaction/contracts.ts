import { createHash } from "node:crypto";

import {
  MODEL_STEPS,
  type ModelStep,
} from "../../../shared/model-steps.js";

export const CONTEXT_COMPACTION_MODEL_STEP = MODEL_STEPS.CONTEXT_COMPACTION;
export const SEMANTIC_COMPACTION_DIGEST_MAX_LENGTH = 2_000;
export const SEMANTIC_COMPACTION_DIGEST_TOTAL_MAX_LENGTH = 8_000;
export const SEMANTIC_COMPACTION_TEXT_MAX_LENGTH = 2_000;
export const SEMANTIC_COMPACTION_LIST_MAX_COUNT = 24;
export const SEMANTIC_COMPACTION_ID_MAX_LENGTH = 256;
export const SEMANTIC_COMPACTION_SCOPE_ID_MAX_LENGTH = 512;
export const SEMANTIC_COMPACTION_CONTEXT_LANE = "role_continuation" as const;

export type SemanticCompactionContextLane =
  typeof SEMANTIC_COMPACTION_CONTEXT_LANE;

export type SemanticCompactionSourceIdentity = Readonly<{
  sourceRef: string;
  sourceFingerprint: string;
}>;

export type SemanticCompactionSource = SemanticCompactionSourceIdentity &
  Readonly<{
    content: string;
  }>;

export type SemanticCompactionDigest = SemanticCompactionSourceIdentity &
  Readonly<{
    digest: string;
  }>;

export type SemanticCompactionContinuation = Readonly<{
  completed: readonly string[];
  currentState: string;
  findings: readonly string[];
  evidenceRefs: readonly string[];
  artifacts: readonly string[];
  decisions: readonly string[];
  failedApproaches: readonly string[];
  openWork: readonly string[];
  blockers: readonly string[];
  nextStep: string;
}>;

export type SemanticCompactionCheckpointBinding = Readonly<{
  requestId: string;
  currentRequestFingerprint: string;
  roleId: string;
  callId: string;
  objectiveFingerprint: string;
  contextLane: SemanticCompactionContextLane;
  allowedConsumers: readonly ModelStep[];
}>;

export type SemanticCompactionApplicability = Readonly<
  Omit<SemanticCompactionCheckpointBinding, "allowedConsumers"> & {
    consumer: ModelStep;
  }
>;

export type SemanticCompactionCheckpoint =
  SemanticCompactionCheckpointBinding &
    Readonly<{
      kind: "runtime_semantic_compaction_checkpoint_v2";
      scopeId: string;
      sourceRevision: number;
      sourceDigests: readonly SemanticCompactionDigest[];
      continuation: SemanticCompactionContinuation;
    }>;

export type SemanticCompactionCandidate = SemanticCompactionCheckpoint;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MODEL_STEP_IDS = new Set<ModelStep>(Object.values(MODEL_STEPS));

export function createSemanticCompactionSha256Fingerprint(
  value: string,
): string {
  if (typeof value !== "string") {
    throw new Error("context_compaction_fingerprint_input_invalid");
  }
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function isSemanticCompactionSha256Fingerprint(
  value: unknown,
): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function assertValidSemanticCompactionCheckpointBinding(
  binding: SemanticCompactionCheckpointBinding,
): void {
  if (
    !isBoundedId(binding.requestId) ||
    !isSemanticCompactionSha256Fingerprint(
      binding.currentRequestFingerprint,
    ) ||
    !isBoundedId(binding.roleId) ||
    !isBoundedId(binding.callId) ||
    !isSemanticCompactionSha256Fingerprint(binding.objectiveFingerprint) ||
    binding.contextLane !== SEMANTIC_COMPACTION_CONTEXT_LANE ||
    !Array.isArray(binding.allowedConsumers) ||
    binding.allowedConsumers.length === 0 ||
    new Set(binding.allowedConsumers).size !== binding.allowedConsumers.length ||
    binding.allowedConsumers.some((consumer) => !MODEL_STEP_IDS.has(consumer))
  ) {
    throw new Error("context_compaction_checkpoint_binding_invalid");
  }
}

export function sameSemanticCompactionCheckpointBinding(
  left: SemanticCompactionCheckpointBinding,
  right: SemanticCompactionCheckpointBinding,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.currentRequestFingerprint === right.currentRequestFingerprint &&
    left.roleId === right.roleId &&
    left.callId === right.callId &&
    left.objectiveFingerprint === right.objectiveFingerprint &&
    left.contextLane === right.contextLane &&
    left.allowedConsumers.length === right.allowedConsumers.length &&
    left.allowedConsumers.every(
      (consumer, index) => consumer === right.allowedConsumers[index],
    )
  );
}

export function semanticCompactionDigestTotalLength(
  sourceDigests: readonly SemanticCompactionDigest[],
): number {
  return sourceDigests.reduce(
    (total, sourceDigest) => total + sourceDigest.digest.length,
    0,
  );
}

export function semanticCompactionContinuationTotalLength(
  continuation: SemanticCompactionContinuation,
): number {
  return (
    continuation.currentState.length +
    continuation.nextStep.length +
    continuation.completed.reduce((total, entry) => total + entry.length, 0) +
    continuation.findings.reduce((total, entry) => total + entry.length, 0) +
    continuation.evidenceRefs.reduce((total, entry) => total + entry.length, 0) +
    continuation.artifacts.reduce((total, entry) => total + entry.length, 0) +
    continuation.decisions.reduce((total, entry) => total + entry.length, 0) +
    continuation.failedApproaches.reduce(
      (total, entry) => total + entry.length,
      0,
    ) +
    continuation.openWork.reduce((total, entry) => total + entry.length, 0) +
    continuation.blockers.reduce((total, entry) => total + entry.length, 0)
  );
}

export function assertValidSemanticCompactionCheckpoint(
  checkpoint: SemanticCompactionCheckpoint,
): void {
  assertValidSemanticCompactionCheckpointBinding(checkpoint);
  if (
    checkpoint.kind !== "runtime_semantic_compaction_checkpoint_v2" ||
    !isBoundedId(checkpoint.scopeId, SEMANTIC_COMPACTION_SCOPE_ID_MAX_LENGTH) ||
    !Number.isSafeInteger(checkpoint.sourceRevision) ||
    checkpoint.sourceRevision < 0 ||
    !Array.isArray(checkpoint.sourceDigests) ||
    checkpoint.sourceDigests.length === 0
  ) {
    throw new Error("context_compaction_checkpoint_invalid");
  }
  const sourceRefs = new Set<string>();
  for (const sourceDigest of checkpoint.sourceDigests) {
    if (
      !isBoundedId(sourceDigest.sourceRef) ||
      sourceRefs.has(sourceDigest.sourceRef) ||
      !isSemanticCompactionSha256Fingerprint(
        sourceDigest.sourceFingerprint,
      ) ||
      !isBoundedText(
        sourceDigest.digest,
        SEMANTIC_COMPACTION_DIGEST_MAX_LENGTH,
      )
    ) {
      throw new Error("context_compaction_checkpoint_source_invalid");
    }
    sourceRefs.add(sourceDigest.sourceRef);
  }
  if (
    semanticCompactionDigestTotalLength(checkpoint.sourceDigests) >
      SEMANTIC_COMPACTION_DIGEST_TOTAL_MAX_LENGTH ||
    !isValidContinuation(checkpoint.continuation) ||
    semanticCompactionContinuationTotalLength(checkpoint.continuation) >
      SEMANTIC_COMPACTION_DIGEST_TOTAL_MAX_LENGTH
  ) {
    throw new Error("context_compaction_checkpoint_content_invalid");
  }
}

export function isSemanticCompactionCheckpointApplicable(
  checkpoint: SemanticCompactionCheckpoint,
  applicability: SemanticCompactionApplicability,
): boolean {
  try {
    assertValidSemanticCompactionCheckpoint(checkpoint);
  } catch {
    return false;
  }
  return (
    checkpoint.requestId === applicability.requestId &&
    checkpoint.currentRequestFingerprint ===
      applicability.currentRequestFingerprint &&
    checkpoint.roleId === applicability.roleId &&
    checkpoint.callId === applicability.callId &&
    checkpoint.objectiveFingerprint === applicability.objectiveFingerprint &&
    checkpoint.contextLane === applicability.contextLane &&
    checkpoint.allowedConsumers.includes(applicability.consumer)
  );
}

function isValidContinuation(
  continuation: SemanticCompactionContinuation,
): boolean {
  return (
    continuation !== null &&
    typeof continuation === "object" &&
    isBoundedText(
      continuation.currentState,
      SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
    ) &&
    isBoundedText(
      continuation.nextStep,
      SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
    ) &&
    [
      continuation.completed,
      continuation.findings,
      continuation.evidenceRefs,
      continuation.artifacts,
      continuation.decisions,
      continuation.failedApproaches,
      continuation.openWork,
      continuation.blockers,
    ].every(isBoundedTextList)
  );
}

function isBoundedTextList(value: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length <= SEMANTIC_COMPACTION_LIST_MAX_COUNT &&
    value.every((entry) =>
      isBoundedText(entry, SEMANTIC_COMPACTION_TEXT_MAX_LENGTH),
    )
  );
}

function isBoundedText(value: string, maxLength: number): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    value.length <= maxLength
  );
}

function isBoundedId(
  value: string,
  maxLength = SEMANTIC_COMPACTION_ID_MAX_LENGTH,
): boolean {
  return isBoundedText(value, maxLength);
}
