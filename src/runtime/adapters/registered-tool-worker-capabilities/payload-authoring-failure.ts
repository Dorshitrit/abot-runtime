import type { WorkerCapabilityPayloadAuthoringResult } from "../../orchestration/worker-capabilities/payload-contracts.js";
import { hasPayloadTimeoutDuration } from "../../orchestration/worker-capabilities/payload-author-failure.js";

type PayloadTimeout = Extract<WorkerCapabilityPayloadAuthoringResult, { code: "payload_model_timed_out" }>;
type PayloadFailure = Readonly<{ status: "failed"; code: string }>;

export function normalizePayloadTimeoutFailure(
  input: Record<string, unknown>,
): PayloadTimeout | undefined {
  if (input.status !== "failed" || input.code !== "payload_model_timed_out") return undefined;
  if (Object.keys(input).some(key => !["status", "code", "timeoutMs"].includes(key))) return undefined;
  if (Object.hasOwn(input, "timeoutMs") && !hasPayloadTimeoutDuration(input.timeoutMs)) return undefined;
  return Object.freeze({
    status: "failed",
    code: "payload_model_timed_out",
    ...(hasPayloadTimeoutDuration(input.timeoutMs) ? { timeoutMs: input.timeoutMs } : {}),
  });
}

export function payloadAuthoringFailureMessage(
  failure: PayloadFailure | PayloadTimeout,
  fallback: string,
): string {
  if (failure.code !== "payload_model_timed_out") return fallback;
  const duration = "timeoutMs" in failure && hasPayloadTimeoutDuration(failure.timeoutMs)
    ? ` after ${failure.timeoutMs} ms` : "";
  return `Payload generation timed out${duration}. No tool action was executed.`;
}
