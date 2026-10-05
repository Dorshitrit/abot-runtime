import type { AutomationStepCompletion } from "./graph-executor.js";

/** Normalize definite abort receipts before their durable node settlement. */
export function normalizeAutomationStepInterruption(
  completion: AutomationStepCompletion,
  signal: AbortSignal,
): AutomationStepCompletion {
  if (completion.uncertain) return completion;
  if (!signal.aborted) return completion;
  const durationFailureCode = automationDurationFailureCode(signal.reason);
  if (durationFailureCode && completion.status === "cancelled")
    return { status: "failed", errorCode: durationFailureCode };
  if (durationFailureCode) return completion;
  if (completion.status !== "failed" && completion.status !== "skipped") return completion;
  if (completion.errorCode !== "request_aborted") return completion;
  return { status: "cancelled", errorCode: "automation_run_stopped" };
}

function automationDurationFailureCode(reason: unknown): string | undefined {
  if (!(reason instanceof Error)) return undefined;
  if (reason.message === "automation_run_duration_exceeded") return reason.message;
  if (reason.message === "automation_budget_exhausted") return reason.message;
  return undefined;
}
