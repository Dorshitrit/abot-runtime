import type {
  WorkerCapabilityExecutionFreshness,
  WorkerCapabilityPreparedExecution,
} from "../contracts.js";

export const STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION =
  "steering_superseded_before_external_execution" as const;
export const STEERING_SUPERSEDED_SUMMARY =
  "steering_superseded_before_external_execution: No external execution occurred because a newer active-request update superseded this capability invocation.";

/** Preserve the admitted identity and decision binding; only fence its dispatch. */
export function fenceRestoredApprovalExecution(
  prepared: WorkerCapabilityPreparedExecution,
  freshness: WorkerCapabilityExecutionFreshness | undefined,
): WorkerCapabilityPreparedExecution {
  if (!freshness) return prepared;
  return Object.freeze({
    ...prepared,
    async execute(executionId: string) {
      if (freshness.isCurrent()) return prepared.execute(executionId);
      if (prepared.rejectBeforeExecution)
        return prepared.rejectBeforeExecution(
          executionId,
          STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION,
          STEERING_SUPERSEDED_SUMMARY,
        );
      return Object.freeze({
        outcome: "failed" as const,
        observedEffect: "none" as const,
        summary: STEERING_SUPERSEDED_SUMMARY,
        // This is request control, not evidence of a repeatable tool failure.
        failureOutcomeFingerprint: null,
        exactResult: Object.freeze({
          kind: "runtime_capability_rejection_v1" as const,
          authority: "runtime" as const,
          status: "rejected" as const,
          stage: "before_external_execution" as const,
          code: STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION,
          message: STEERING_SUPERSEDED_SUMMARY,
        }),
      });
    },
  });
}
