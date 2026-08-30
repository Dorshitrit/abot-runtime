import {
  createWorkerCapabilityExecutionErrorOutcomeFingerprint,
  createWorkerCapabilityResultRejectionOutcomeFingerprint,
} from "../outcome-fingerprint.js";
import type {
  WorkerCapabilityAdapterResult,
  WorkerCapabilityDescriptor,
  WorkerCapabilityPreparedExecution,
} from "../contracts.js";
import {
  traceWorkerCapabilityExecutionFailed,
  traceWorkerCapabilityResultRejected,
  type WorkerCapabilityDiagnosticContext,
} from "../diagnostics.js";
import {
  createTechnicalExecutionFailureResult,
  normalizeCompletedAdapterExecution,
  type CanonicalWorkerCapabilityExecution,
} from "./adapter-result-normalization.js";

export async function executePreparedAndNormalizeAdapter(params: {
  prepared: WorkerCapabilityPreparedExecution;
  descriptor: WorkerCapabilityDescriptor;
  diagnostic: WorkerCapabilityDiagnosticContext;
  executionId: string;
}): Promise<CanonicalWorkerCapabilityExecution> {
  let rawResult: WorkerCapabilityAdapterResult;
  try {
    rawResult = await params.prepared.execute(params.executionId);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    traceWorkerCapabilityExecutionFailed(
      params.diagnostic,
      params.descriptor,
      error,
      params.executionId,
    );
    const result = createTechnicalExecutionFailureResult(error);
    const outcomeFingerprint =
      createWorkerCapabilityExecutionErrorOutcomeFingerprint(error);
    return Object.freeze({
      result,
      ...(outcomeFingerprint ? { outcomeFingerprint } : {}),
    });
  }

  const normalized = normalizeCompletedAdapterExecution(
    rawResult,
    params.descriptor.effect,
  );
  if (normalized.ok) return normalized.execution;

  traceWorkerCapabilityResultRejected(
    params.diagnostic,
    params.descriptor,
    normalized.issueCode,
    params.executionId,
  );
  return Object.freeze({
    result: normalized.result,
    outcomeFingerprint: createWorkerCapabilityResultRejectionOutcomeFingerprint(
      normalized.issueCode,
    ),
  });
}
