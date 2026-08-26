import type { CapabilityAdapterResult } from "../../orchestration/capability-adapters/index.js";
import type {
  WorkerCapabilityAdapterResult,
  WorkerCapabilityExecutionFreshness,
} from "../../orchestration/worker-capabilities/index.js";
import type { RegisteredToolNormalInvocationExecutor } from "../registered-tool-normal-invocations.js";
import {
  boundedSummary,
  requireCapabilityAdapterResult,
} from "./result-observer.js";

export const STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION =
  "steering_superseded_before_external_execution" as const;
export const STEERING_SUPERSEDED_SUMMARY =
  "steering_superseded_before_external_execution: No external execution occurred because a newer active-request update superseded this capability invocation.";

export type PayloadLifecycleContext = Readonly<
  Omit<
    Parameters<
      RegisteredToolNormalInvocationExecutor["emitPayloadLifecycle"]
    >[0],
    "phase" | "errorCode"
  >
>;

export function rejectPayloadLifecycle(params: {
  executor: RegisteredToolNormalInvocationExecutor;
  lifecycle: PayloadLifecycleContext;
  code: string;
  message: string;
  fallback?: ReturnType<typeof payloadRejection>;
}): ReturnType<typeof payloadRejection> {
  const failed = params.executor.emitPayloadLifecycle({
    ...params.lifecycle,
    phase: "failed",
    errorCode: params.code,
  });
  return failed.status === "rejected"
    ? payloadRejection(failed.code, failed.message)
    : (params.fallback ?? payloadRejection(params.code, params.message));
}

export function payloadRejection(
  sourceIssueCode: string,
  summary: string,
): Readonly<{
  status: "rejected";
  result: WorkerCapabilityAdapterResult;
  sourceIssueCode: string;
  exactResult: CapabilityAdapterResult;
}> {
  return Object.freeze({
    status: "rejected" as const,
    result: Object.freeze({
      outcome: "failed" as const,
      observedEffect: "none" as const,
      summary: boundedSummary(summary),
    }),
    sourceIssueCode,
    exactResult: requireCapabilityAdapterResult({
      kind: "runtime_capability_rejection_v1",
      authority: "runtime",
      status: "rejected",
      stage: "before_external_execution",
      code: sourceIssueCode,
      message: summary,
    }),
  });
}

export function executionFreshnessRejection(
  freshness: WorkerCapabilityExecutionFreshness | undefined,
): ReturnType<typeof payloadRejection> | undefined {
  if (!freshness) return undefined;
  let current = false;
  try {
    current = freshness.isCurrent();
  } catch {
    current = false;
  }
  return current
    ? undefined
    : payloadRejection(
        STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION,
        STEERING_SUPERSEDED_SUMMARY,
      );
}
