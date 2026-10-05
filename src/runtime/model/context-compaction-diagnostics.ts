import type { RequestMessagesBudgetAssessment } from "../context/request-context-budget.js";
import { resolveRequestBudgetInputTokens } from "../context/request-context-budget.js";
import { traceDebug } from "../observability/debug-logger.js";
import type {
  ModelStepCompactionScope,
  ModelStepContextCompactionPreparation,
} from "./context-compaction-contracts.js";

export type ContextCompactionIdentity = Readonly<{
  requestId: string;
  invocationId: string;
  modelStep: string;
  profileId: string;
  provider: string;
  model: string;
  modelInvocationScope?: string;
}>;

/** One external lifecycle; stage and persistence detail stays in bounded debug data. */
export class ContextCompactionDiagnostics {
  private state: "pending" | "open" | "closed" = "pending";

  constructor(
    private readonly identity: ContextCompactionIdentity,
    private readonly before: RequestMessagesBudgetAssessment,
    private readonly firstScope: ModelStepCompactionScope | undefined,
    private readonly onEvent?: (
      name: string,
      extra?: Record<string, unknown>,
    ) => void,
  ) {}

  start(): void {
    this.state = "open";
    this.onEvent?.("context.compaction.started", {
      ...this.base(),
      stage: "context_compaction",
      phase: "started",
      reason: "context_window_threshold",
      compactionScope: this.firstScope,
    });
  }

  trace(event: string, extra: Record<string, unknown>): void {
    traceDebug("runtime.context", `compaction.${event}`, {
      ...this.base(),
      ...extra,
    });
  }

  complete(
    assessment: RequestMessagesBudgetAssessment,
    firstCommitted: Readonly<{
      compactionScope: ModelStepCompactionScope;
      preparation: ModelStepContextCompactionPreparation;
    }>,
  ): void {
    this.state = "closed";
    this.onEvent?.("context.compaction.completed", {
      ...this.base(),
      stage: "context_compaction",
      phase: "completed",
      reason: "context_window_threshold",
      compactionScope: firstCommitted.compactionScope,
      scopeId: firstCommitted.preparation.scopeId,
      sourceRevision: firstCommitted.preparation.sourceRevision,
      coveredSourceCount: firstCommitted.preparation.coveredSourceCount,
      afterInputTokens: resolveRequestBudgetInputTokens(assessment.budget),
      afterUsedContextPercent: assessment.budget.usedContextPercent,
    });
  }

  fail(error: unknown, reason: string, extra: Record<string, unknown>): void {
    this.trace("failed", {
      reason,
      issueCode: compactionIssueCode(error),
      ...extra,
    });
    if (this.state !== "open") return;
    this.state = "closed";
    try {
      this.onEvent?.("context.compaction.failed", {
        ...this.base(),
        stage: "context_compaction",
        phase: "failed",
        reason,
        compactionScope: this.firstScope,
        issueCode: compactionIssueCode(error),
      });
    } catch (deliveryError: unknown) {
      // Failure delivery must not replace cancellation or the original failure.
      this.trace("failure_delivery_failed", {
        issueCode: compactionIssueCode(deliveryError),
      });
    }
  }

  private base(): Record<string, unknown> {
    return {
      ...this.identity,
      contextWindowTokens: this.before.budget.contextWindowTokens,
      beforeInputTokens: resolveRequestBudgetInputTokens(this.before.budget),
      beforeUsedContextPercent: this.before.budget.usedContextPercent,
      triggerInputTokens: this.before.budget.compactionTriggerInputTokens,
      availableInputTokens: this.before.budget.availableInputTokens,
    };
  }
}

export function compactionIssueCode(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  if (typeof error === "string") return error.slice(0, 200);
  return "unknown_error";
}

export function compactionMeasurement(
  assessment: RequestMessagesBudgetAssessment,
) {
  const actual = assessment.budget.measuredInputTokens !== undefined;
  return {
    measurement: actual ? "actual" : "estimated",
    source: actual ? "provider_input_token_count" : "runtime_token_estimator",
  };
}
