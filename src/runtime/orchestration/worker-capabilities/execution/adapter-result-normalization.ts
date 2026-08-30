import {
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  isRoleOperationOutcomeFingerprintForOutcome,
  type RoleCapabilityResultReference,
  type RoleOperationOutcomeFingerprint,
} from "../../role-calls/index.js";
import type {
  WorkerCapabilityAdapterResult,
  WorkerCapabilityEffect,
} from "../contracts.js";
import {
  attachCanonicalExactResult,
  exactResultNormalizationIssueCode,
  type CanonicalWorkerCapabilityAdapterResult,
} from "./adapter-exact-result.js";
import { normalizeResultReferences } from "./adapter-result-references.js";

export type { CanonicalWorkerCapabilityAdapterResult } from "./adapter-exact-result.js";

const TECHNICAL_EXECUTION_FAILURE_SUMMARY =
  "The capability failed before returning a valid result.";
const INVALID_EXECUTION_RESULT_SUMMARY =
  "The capability returned an invalid result.";
const OVERSIZED_EXECUTION_RESULT_SUMMARY =
  "The capability result exceeded the Runtime evidence size limit.";

export type CanonicalWorkerCapabilityExecution = Readonly<{
  result: CanonicalWorkerCapabilityAdapterResult;
  outcomeFingerprint?: RoleOperationOutcomeFingerprint;
}>;

export type CompletedAdapterNormalization =
  | Readonly<{
      ok: true;
      execution: CanonicalWorkerCapabilityExecution;
    }>
  | Readonly<{
      ok: false;
      issueCode: string;
      result: CanonicalWorkerCapabilityAdapterResult;
    }>;

type AdapterResultNormalization =
  | Readonly<{ ok: true; value: CanonicalWorkerCapabilityAdapterResult }>
  | Readonly<{ ok: false; issueCode: string }>;

type NormalizedResultReferences =
  | readonly RoleCapabilityResultReference[]
  | undefined;

export function createTechnicalExecutionFailureResult(
  error: unknown,
): CanonicalWorkerCapabilityAdapterResult {
  return attachCanonicalExactResult(
    technicalFailure(adapterExecutionFailureSummary(error)),
  );
}

export function normalizeCompletedAdapterExecution(
  input: WorkerCapabilityAdapterResult,
  declaredEffect: WorkerCapabilityEffect,
): CompletedAdapterNormalization {
  let normalized: ReturnType<typeof normalizeAdapterResult>;
  try {
    normalized = normalizeAdapterResult(input, declaredEffect);
  } catch (error: unknown) {
    normalized = {
      ok: false,
      issueCode: exactResultNormalizationIssueCode(error),
    };
  }
  if (normalized.ok) {
    return {
      ok: true,
      execution: canonicalExecution(normalized.value),
    };
  }
  return {
    ok: false,
    issueCode: normalized.issueCode,
    result: attachCanonicalExactResult(
      technicalFailure(
        normalized.issueCode === "adapter_result_too_large"
          ? OVERSIZED_EXECUTION_RESULT_SUMMARY
          : INVALID_EXECUTION_RESULT_SUMMARY,
      ),
    ),
  };
}

function normalizeAdapterResult(
  input: WorkerCapabilityAdapterResult,
  declaredEffect: WorkerCapabilityEffect,
): AdapterResultNormalization {
  if (!isAdapterResultRecord(input)) {
    return { ok: false, issueCode: "adapter_result_not_object" };
  }
  if (!hasSupportedAdapterResultShape(input)) {
    return { ok: false, issueCode: "adapter_result_shape_invalid" };
  }
  if (!hasValidAdapterResultSummary(input.summary)) {
    return { ok: false, issueCode: "adapter_result_summary_invalid" };
  }
  if (!hasValidAdapterReferenceData(input.referenceData)) {
    return { ok: false, issueCode: "adapter_result_reference_data_invalid" };
  }
  const references = normalizeResultReferences(input.references);
  if (references === null) {
    return { ok: false, issueCode: "adapter_result_references_invalid" };
  }
  if (input.outcome === "succeeded") {
    return normalizeSucceededAdapterResult(input, declaredEffect, references);
  }
  if (input.outcome === "failed") {
    return normalizeFailedAdapterResult(input, declaredEffect, references);
  }
  return { ok: false, issueCode: "adapter_result_outcome_invalid" };
}

function normalizeSucceededAdapterResult(
  input: Extract<WorkerCapabilityAdapterResult, { outcome: "succeeded" }>,
  declaredEffect: WorkerCapabilityEffect,
  references: NormalizedResultReferences,
): AdapterResultNormalization {
  if (Object.hasOwn(input, "failureOutcomeFingerprint")) {
    return {
      ok: false,
      issueCode: "adapter_result_failure_outcome_fingerprint_unexpected",
    };
  }
  if (
    !isSuccessfulObservedEffectCompatible(input.observedEffect, declaredEffect)
  ) {
    return { ok: false, issueCode: "observed_effect_mismatch" };
  }
  return {
    ok: true,
    value: attachCanonicalExactResult(
      Object.freeze({
        outcome: "succeeded",
        observedEffect: input.observedEffect,
        summary: input.summary.trim(),
        ...(input.referenceData
          ? { referenceData: input.referenceData.trim() }
          : {}),
        ...(references ? { references } : {}),
      }),
      input,
    ),
  };
}

function normalizeFailedAdapterResult(
  input: Extract<WorkerCapabilityAdapterResult, { outcome: "failed" }>,
  declaredEffect: WorkerCapabilityEffect,
  references: NormalizedResultReferences,
): AdapterResultNormalization {
  if (!Object.hasOwn(input, "failureOutcomeFingerprint")) {
    return {
      ok: false,
      issueCode: "adapter_result_failure_outcome_fingerprint_missing",
    };
  }
  if (
    input.failureOutcomeFingerprint !== null &&
    !isRoleOperationOutcomeFingerprintForOutcome(
      input.failureOutcomeFingerprint,
      "failed",
    )
  ) {
    return {
      ok: false,
      issueCode: "adapter_result_failure_outcome_fingerprint_invalid",
    };
  }
  if (!isFailedObservedEffectCompatible(input.observedEffect, declaredEffect)) {
    return { ok: false, issueCode: "failed_effect_invalid" };
  }
  return {
    ok: true,
    value: attachCanonicalExactResult(
      Object.freeze({
        outcome: "failed",
        observedEffect: input.observedEffect,
        summary: input.summary.trim(),
        ...(input.referenceData
          ? { referenceData: input.referenceData.trim() }
          : {}),
        ...(references ? { references } : {}),
        failureOutcomeFingerprint: input.failureOutcomeFingerprint,
      }),
      input,
    ),
  };
}

function isAdapterResultRecord(input: unknown): boolean {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasSupportedAdapterResultShape(
  input: WorkerCapabilityAdapterResult,
): boolean {
  const keys = Object.keys(input);
  if (keys.length < 3 || keys.length > 7) return false;
  if (!keys.includes("outcome")) return false;
  if (!keys.includes("observedEffect")) return false;
  if (!keys.includes("summary")) return false;
  return keys.every((key) =>
    [
      "outcome",
      "observedEffect",
      "summary",
      "referenceData",
      "references",
      "exactResult",
      "failureOutcomeFingerprint",
    ].includes(key),
  );
}

function hasValidAdapterResultSummary(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    input.length <= ROLE_CALL_RESULT_MAX_LENGTH
  );
}

function hasValidAdapterReferenceData(input: unknown): boolean {
  if (input === undefined) return true;
  return (
    typeof input === "string" &&
    input.trim().length > 0 &&
    input.length <= ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH
  );
}

function canonicalExecution(
  result: CanonicalWorkerCapabilityAdapterResult,
): CanonicalWorkerCapabilityExecution {
  if (result.outcome === "succeeded") {
    return Object.freeze({ result, outcomeFingerprint: "succeeded" as const });
  }
  const outcomeFingerprint = result.failureOutcomeFingerprint ?? undefined;
  return Object.freeze({
    result,
    ...(outcomeFingerprint ? { outcomeFingerprint } : {}),
  });
}

function adapterExecutionFailureSummary(error: unknown): string {
  if (!(error instanceof Error)) return TECHNICAL_EXECUTION_FAILURE_SUMMARY;
  if (error.message.endsWith("canonical_result_result_too_large")) {
    return OVERSIZED_EXECUTION_RESULT_SUMMARY;
  }
  if (error.message.endsWith("canonical_result_result_invalid")) {
    return INVALID_EXECUTION_RESULT_SUMMARY;
  }
  if (error.message.endsWith("canonical_result_result_not_json_safe")) {
    return INVALID_EXECUTION_RESULT_SUMMARY;
  }
  return TECHNICAL_EXECUTION_FAILURE_SUMMARY;
}

function isSuccessfulObservedEffectCompatible(
  observedEffect: unknown,
  declaredEffect: WorkerCapabilityEffect,
): observedEffect is "observation" | "mutation" {
  if (declaredEffect === "mixed") {
    return observedEffect === "observation" || observedEffect === "mutation";
  }
  return observedEffect === declaredEffect;
}

function isFailedObservedEffectCompatible(
  observedEffect: unknown,
  declaredEffect: WorkerCapabilityEffect,
): boolean {
  if (observedEffect === "none") return true;
  if (observedEffect === "indeterminate") return true;
  if (observedEffect === "observation") return true;
  if (observedEffect !== "mutation") return false;
  return declaredEffect === "mutation" || declaredEffect === "mixed";
}

function technicalFailure(summary: string): WorkerCapabilityAdapterResult {
  return Object.freeze({
    outcome: "failed",
    observedEffect: "indeterminate",
    summary,
    failureOutcomeFingerprint: null,
  });
}
