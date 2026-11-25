import type { ModelStep } from "../../../shared/model-steps.js";
import { ModelStepTimeoutError } from "../../steps/model-step-timeout.js";
import {
  WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
  type WorkerCapabilityPayloadAuthoringResult,
} from "./payload-contracts.js";
import {
  traceWorkerCapabilityPayloadFailed,
  type WorkerCapabilityPayloadDiagnosticContext,
} from "./payload-diagnostics.js";

type PayloadFailure = Extract<WorkerCapabilityPayloadAuthoringResult, { status: "failed" }>;
type PayloadTimeout = Extract<PayloadFailure, { code: "payload_model_timed_out" }>;

export function workerPayloadFailure(
  diagnostic: WorkerCapabilityPayloadDiagnosticContext,
  code: Exclude<PayloadFailure["code"], "payload_model_timed_out">,
  error?: unknown,
): PayloadFailure {
  traceWorkerCapabilityPayloadFailed(diagnostic, code, error);
  return Object.freeze({ status: "failed", code });
}

export function payloadInvocationFailure(
  diagnostic: WorkerCapabilityPayloadDiagnosticContext,
  error: unknown,
): PayloadFailure {
  const timeout = resolvePayloadModelTimeout(error, WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP);
  if (!timeout) return workerPayloadFailure(diagnostic, "payload_model_invocation_failed", error);
  traceWorkerCapabilityPayloadFailed(diagnostic, timeout.code, error);
  return timeout;
}

/** Only an owned model-step deadline establishes a payload-generation timeout. */
export function resolvePayloadModelTimeout(
  error: unknown,
  modelStep: ModelStep,
): PayloadTimeout | undefined {
  if (!(error instanceof ModelStepTimeoutError)) return undefined;
  if (error.modelStep !== modelStep) return undefined;
  return Object.freeze({
    status: "failed",
    code: "payload_model_timed_out",
    ...(hasPayloadTimeoutDuration(error.timeoutMs) ? { timeoutMs: error.timeoutMs } : {}),
  });
}

export function hasPayloadTimeoutDuration(value: unknown): value is number {
  if (typeof value !== "number") return false;
  return Number.isSafeInteger(value) && value > 0;
}
