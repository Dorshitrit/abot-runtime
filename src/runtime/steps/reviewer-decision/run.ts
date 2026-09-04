import {
  invokeStructuredModelStep,
  StructuredModelInvalidOutputError,
} from "../../model/invoke-structured-step.js";
import { emitRuntimeStatus } from "../../events/runtime-status.js";
import { classifyRuntimeErrorType } from "../../observability/error-type.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import type { RoleExecutor } from "../../orchestration/role-executors/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestRoleExecutionHandoff } from "../../request/result.js";
import { createRoleCallReviewerVerdictReceipt } from "../../orchestration/role-calls/index.js";
import {
  REVIEWER_DECISION_MODEL_STEP,
  type ReviewerDecision,
  type ReviewerDecisionDiagnosticContext,
  type ReviewerReviewSnapshot,
} from "./contracts.js";
import {
  traceReviewerExecutionMapped,
  traceReviewerModelCompleted,
  traceReviewerModelFailed,
  traceReviewerModelStarted,
} from "./diagnostics.js";
import type { ReviewerReferenceDataBudget } from "./final-evidence.js";
import {
  assessReviewerDecisionInputBudget,
  buildReviewerDecisionInput,
  resolveReviewerDecisionContextBudget,
} from "./input.js";
import { parseReviewerDecisionOutput } from "./parser.js";
import { projectReviewerReviewSnapshot } from "./projection.js";

export async function runReviewerDecision(
  request: RequestExecutionScope,
  options: Readonly<{
    call: Parameters<typeof buildReviewerDecisionInput>[1]["call"];
    snapshot: ReviewerReviewSnapshot;
    budget: NonNullable<
      Parameters<typeof buildReviewerDecisionInput>[1]["budget"]
    >;
    referenceDataBudget: ReviewerReferenceDataBudget;
  }>,
): Promise<ReviewerDecision> {
  const input = buildReviewerDecisionInput(request, options);
  const diagnostic: ReviewerDecisionDiagnosticContext = input.diagnostic;
  const startedAt = Date.now();

  traceReviewerModelStarted({
    diagnostic,
    messageCount: input.context.messages.length,
    messageCharacterCount: input.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
  });

  try {
    const decision = await invokeStructuredModelStep({
      request,
      modelStep: input.modelStep,
      format: input.format,
      messages: input.context.messages,
      contextCompaction: createModelStepCompactionController(request, {
        call: options.call,
        sourceRevision: options.snapshot.sourceRevision,
        allowedConsumers: Object.freeze([REVIEWER_DECISION_MODEL_STEP]),
      }),
      timeoutReason: "reviewer_decision_timeout",
      invalidOutputReason: "invalid_reviewer_decision",
      parse: (text) =>
        parseReviewerDecisionOutput(text, {
          snapshot: input.snapshot,
          diagnostic,
        }),
    });
    traceReviewerModelCompleted({
      diagnostic,
      decision,
      durationMs: Date.now() - startedAt,
    });
    return decision;
  } catch (error: unknown) {
    traceReviewerModelFailed({
      diagnostic,
      durationMs: Date.now() - startedAt,
      errorType: classifyRuntimeErrorType(error),
      invalidStructuredOutput:
        error instanceof StructuredModelInvalidOutputError,
    });
    throw error;
  }
}

export const GENERIC_REVIEWER_EXECUTOR: RoleExecutor<
  RequestExecutionScope,
  RequestRoleExecutionHandoff
> = Object.freeze({
  roleId: "reviewer",
  async execute({ context, call, ledger, continuation }) {
    if (continuation) {
      throw new Error("reviewer_continuation_unsupported");
    }
    emitRuntimeStatus(context, {
      stage: "reviewer",
      phase: "reviewing",
      message: "Reviewing high-level completion...",
    });
    const budget = resolveReviewerDecisionContextBudget(context);
    const emptyReferenceDataBudget: ReviewerReferenceDataBudget = Object.freeze(
      {
        maxTokens: 0,
        ...(budget.tokenEstimation
          ? { tokenEstimation: budget.tokenEstimation }
          : {}),
      },
    );
    const projectSnapshot = (
      referenceDataBudget: ReviewerReferenceDataBudget,
      trace: boolean,
    ) =>
      projectReviewerReviewSnapshot({
        requestId: context.requestId,
        requestObjective: context.prompt,
        ledger,
        call,
        referenceDataBudget,
        ...(context.contextCompactionStore
          ? { contextCompactionStore: context.contextCompactionStore }
          : {}),
        trace,
      });
    const baseSnapshot = projectSnapshot(emptyReferenceDataBudget, false);
    // Reserve the larger verdict schema while sizing evidence. The zero-data
    // projection is intentionally incomplete only because this pass omits all
    // reference bodies; the final snapshot still owns actual pass eligibility.
    const budgetAssessmentSnapshot = Object.freeze({
      ...baseSnapshot,
      projectionComplete: true,
      freshness: "current" as const,
    });
    const baseAssessment = assessReviewerDecisionInputBudget(context, {
      call,
      snapshot: budgetAssessmentSnapshot,
      budget,
    });
    const referenceDataBudget = resolveReviewerReferenceDataBudget({
      context,
      call,
      budget,
      baseAssessment,
      projectSnapshot,
    });
    const snapshot = projectSnapshot(referenceDataBudget, true);
    const decision = await runReviewerDecision(context, {
      call,
      snapshot,
      budget,
      referenceDataBudget,
    });
    const receipt = createRoleCallReviewerVerdictReceipt({
      reviewerCallId: call.callId,
      callerCallId: snapshot.callerCallId,
      reviewScopeId: decision.reviewScopeId,
      sourceRevision: snapshot.sourceRevision,
      verdict: decision.action,
      gaps: decision.gaps,
    });
    traceReviewerExecutionMapped({
      requestId: context.requestId,
      call,
      sourceRevision: snapshot.sourceRevision,
      decision,
      serializedLength: JSON.stringify(receipt).length,
    });
    return Object.freeze({
      kind: "terminal",
      outcome: "completed",
      summary: decision.summary,
      receipt,
    });
  },
});

function resolveReviewerReferenceDataBudget(
  params: Readonly<{
    context: RequestExecutionScope;
    call: Parameters<typeof buildReviewerDecisionInput>[1]["call"];
    budget: NonNullable<
      Parameters<typeof buildReviewerDecisionInput>[1]["budget"]
    >;
    baseAssessment: ReturnType<typeof assessReviewerDecisionInputBudget>;
    projectSnapshot: (
      budget: ReviewerReferenceDataBudget,
      trace: boolean,
    ) => ReviewerReviewSnapshot;
  }>,
): ReviewerReferenceDataBudget {
  const inputTokenCeiling = Math.min(
    params.baseAssessment.budget.availableInputTokens,
    params.baseAssessment.budget.compactionTriggerInputTokens - 1,
  );
  let low = 0;
  let high = Math.max(
    0,
    inputTokenCeiling - params.baseAssessment.budget.estimatedInputTokens,
  );
  let selectedMaxTokens = 0;

  while (low <= high) {
    const maxTokens = Math.floor((low + high) / 2);
    const candidateBudget = createReviewerReferenceDataBudget(
      maxTokens,
      params.budget,
    );
    const candidateSnapshot = params.projectSnapshot(candidateBudget, false);
    const assessment = assessReviewerDecisionInputBudget(params.context, {
      call: params.call,
      snapshot: candidateSnapshot,
      budget: params.budget,
    });
    if (
      assessment.fits &&
      assessment.budget.estimatedInputTokens <= inputTokenCeiling
    ) {
      selectedMaxTokens = maxTokens;
      low = maxTokens + 1;
    } else {
      high = maxTokens - 1;
    }
  }

  return createReviewerReferenceDataBudget(selectedMaxTokens, params.budget);
}

function createReviewerReferenceDataBudget(
  maxTokens: number,
  budget: NonNullable<
    Parameters<typeof buildReviewerDecisionInput>[1]["budget"]
  >,
): ReviewerReferenceDataBudget {
  return Object.freeze({
    maxTokens,
    ...(budget.tokenEstimation
      ? { tokenEstimation: budget.tokenEstimation }
      : {}),
  });
}
