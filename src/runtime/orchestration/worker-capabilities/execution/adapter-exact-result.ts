import {
  captureLegacyCapabilityAdapterResult,
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResult,
} from "../../capability-adapters/result.js";
import type { WorkerCapabilityAdapterResult } from "../contracts.js";

export type CanonicalWorkerCapabilityAdapterResult =
  WorkerCapabilityAdapterResult &
    Readonly<{ exactResult: CapabilityAdapterResult }>;

export function exactResultNormalizationIssueCode(error: unknown): string {
  if (!(error instanceof Error)) return "adapter_result_unreadable";
  const prefix = "capability_exact_result_invalid:";
  if (!error.message.startsWith(prefix)) return "adapter_result_unreadable";
  const code = error.message.slice(prefix.length);
  if (!isKnownExactResultIssueCode(code)) return "adapter_result_unreadable";
  return `adapter_${code}`;
}

export function attachCanonicalExactResult(
  normalized: WorkerCapabilityAdapterResult,
  raw: WorkerCapabilityAdapterResult = normalized,
): CanonicalWorkerCapabilityAdapterResult {
  const exact =
    raw.exactResult === undefined
      ? captureLegacyCapabilityAdapterResult(omitAdapterBoundaryMetadata(raw))
      : normalizeCapabilityAdapterResult(raw.exactResult);
  if (!exact.ok) {
    throw new Error(`capability_exact_result_invalid:${exact.code}`);
  }
  return Object.freeze({
    ...normalized,
    exactResult: exact.value,
  });
}

function isKnownExactResultIssueCode(
  code: string,
): code is "result_invalid" | "result_not_json_safe" | "result_too_large" {
  return (
    code === "result_invalid" ||
    code === "result_not_json_safe" ||
    code === "result_too_large"
  );
}

function omitAdapterBoundaryMetadata(
  result: WorkerCapabilityAdapterResult,
): Omit<WorkerCapabilityAdapterResult, "failureOutcomeFingerprint"> {
  if (result.outcome === "succeeded") return result;
  const { failureOutcomeFingerprint: _failureOutcomeFingerprint, ...evidence } =
    result;
  return evidence;
}
