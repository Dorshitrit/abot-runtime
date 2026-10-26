import {
  assertCompactionStagePlan,
  assertPreparationStageBinding,
} from "./context-compaction-stage-plan.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import {
  resolveRequestBudgetInputTokens,
  type RequestMessagesBudgetAssessment,
} from "../context/request-context-budget.js";
import type {
  ModelStepCompactionStage,
  ModelStepContextCompactionController,
  ModelStepContextCompactionPreparation,
} from "./context-compaction-contracts.js";
import {
  ContextCompactionDiagnostics,
  compactionIssueCode,
  compactionMeasurement,
  type ContextCompactionIdentity,
} from "./context-compaction-diagnostics.js";
import { isCompactionSteeringSuperseded } from "./model-step-steering.js";
import { ModelStepTimeoutError } from "../steps/model-step-timeout.js";
import { prepareProjectionRepair } from "./context-compaction-projection-repair.js";

type CompactionEnvelope = Readonly<{
  messages: readonly ChatMessage[];
  assessment: RequestMessagesBudgetAssessment;
}>;

type RetainedStage = Readonly<{
  compactionScope: ModelStepCompactionStage["compactionScope"];
  preparation: ModelStepContextCompactionPreparation;
}>;

export function requiresContextCompaction(
  eligible: boolean,
  assessment: RequestMessagesBudgetAssessment,
): boolean {
  if (!eligible) return false;
  if (!assessment.fits) return true;
  return (
    resolveRequestBudgetInputTokens(assessment.budget) >=
    assessment.budget.compactionTriggerInputTokens
  );
}

export function hasReducedProjection(
  candidate: RequestMessagesBudgetAssessment,
  previous: RequestMessagesBudgetAssessment,
): boolean {
  return (
    resolveRequestBudgetInputTokens(candidate.budget) <
    resolveRequestBudgetInputTokens(previous.budget)
  );
}

export function isCompactedEnvelopeAdmissible(
  candidate: RequestMessagesBudgetAssessment,
  original: RequestMessagesBudgetAssessment,
): boolean {
  if (!candidate.fits) return false;
  if (requiresContextCompaction(true, candidate)) return false;
  return hasReducedProjection(candidate, original);
}

function canAdmitPreparedCompactedContext(
  candidate: CompactionEnvelope,
  original: RequestMessagesBudgetAssessment,
  retained: readonly RetainedStage[],
  plannedStageCount: number,
): boolean {
  if (isCompactedEnvelopeAdmissible(candidate.assessment, original))
    return true;
  if (!candidate.assessment.fits) return false;
  if (!hasReducedProjection(candidate.assessment, original)) return false;
  if (retained.length !== plannedStageCount) return false;
  if (retained.at(-1)?.preparation.messages !== candidate.messages)
    return false;
  return retained.every(
    ({ preparation }) => preparation.hasExhaustedCompactionSources === true,
  );
}

function canAdmitReusedCompactedContext(
  assessment: RequestMessagesBudgetAssessment,
  controller: ModelStepContextCompactionController | undefined,
  messages: readonly ChatMessage[],
): boolean {
  if (!assessment.fits) return false;
  return controller?.hasExhaustedVerifiedCompactionSources?.(messages) === true;
}

function hasChangedOptionalContextProjection(
  candidate: readonly ChatMessage[] | undefined,
  previous: readonly ChatMessage[],
): candidate is readonly ChatMessage[] {
  if (!candidate) return false;
  return candidate !== previous;
}

/** The model boundary owns budget decisions; stages own source selection only. */
export async function admitCompactedContext(
  params: CompactionEnvelope &
    Readonly<{
      controller: ModelStepContextCompactionController | undefined;
      assess(
        messages: readonly ChatMessage[],
      ): Promise<RequestMessagesBudgetAssessment>;
      assertCurrent(): void;
      assertNotAborted(): void;
      abortSignal: AbortSignal;
      identity: ContextCompactionIdentity;
      onEvent?: (name: string, extra?: Record<string, unknown>) => void;
    }>,
): Promise<CompactionEnvelope> {
  params.assertCurrent();
  const stages = [...(params.controller?.getStages() ?? [])];
  assertCompactionStagePlan(stages);
  const diagnostics = new ContextCompactionDiagnostics(
    params.identity,
    params.assessment,
    stages[0]?.compactionScope,
    params.onEvent,
  );
  let current: CompactionEnvelope = params;
  const retained: RetainedStage[] = [];
  const committedScopes: string[] = [];
  let commitInProgress: ModelStepCompactionStage["compactionScope"] | undefined;
  let activeStage: ModelStepCompactionStage | undefined;
  let lastCandidate: RequestMessagesBudgetAssessment | undefined;
  let onlyEmptyActiveSource = false;

  try {
    params.assertCurrent();
    const optionalProjection = params.controller?.projectForCompaction?.(
      current.messages,
    );
    if (
      hasChangedOptionalContextProjection(optionalProjection, current.messages)
    ) {
      params.assertCurrent();
      const assessment = await params.assess(optionalProjection);
      params.assertCurrent();
      current = { messages: optionalProjection, assessment };
    }
    if (isCompactedEnvelopeAdmissible(current.assessment, params.assessment)) {
      diagnostics.trace("admitted", {
        outcome: "admitted",
        reason: "optional_context_removed_within_budget",
        committedScopes,
        ...compactionMeasurement(current.assessment),
        afterInputTokens: resolveRequestBudgetInputTokens(
          current.assessment.budget,
        ),
      });
      return current;
    }
    if (
      canAdmitReusedCompactedContext(
        current.assessment,
        params.controller,
        current.messages,
      )
    ) {
      params.assertCurrent();
      diagnostics.trace("admitted", {
        outcome: "admitted",
        reason: "verified_compacted_evidence_within_budget",
        committedScopes,
        ...compactionMeasurement(current.assessment),
        afterInputTokens: resolveRequestBudgetInputTokens(
          current.assessment.budget,
        ),
      });
      return current;
    }
    params.assertCurrent();
    diagnostics.start();
    if (!params.controller)
      throw new Error("request_context_compaction_required");

    // Finish the captured compaction cycle before its caller applies new steering.
    // Cancellation still fences every preparation, measurement and commit.
    for (const [stageIndex, stage] of stages.entries()) {
      activeStage = stage;
      params.assertNotAborted();
      const outcome = await stage.prepare(current.messages);
      params.assertNotAborted();
      const stageMetadata = {
        stageIndex,
        compactionScope: stage.compactionScope,
        scopeId: stage.scopeId,
        currentInputTokens: resolveRequestBudgetInputTokens(
          current.assessment.budget,
        ),
        ...compactionMeasurement(current.assessment),
      };
      if (outcome.kind === "unavailable") {
        onlyEmptyActiveSource = isEmptyActiveOnlyPlan(
          stages,
          stage,
          outcome.reason,
        );
        diagnostics.trace("stage", {
          ...stageMetadata,
          outcome: "unavailable",
          reason: outcome.reason,
        });
        continue;
      }
      let prepared = outcome.preparation;
      assertPreparationStageBinding(stage, prepared);
      params.assertNotAborted();
      let candidate = await params.assess(prepared.messages);
      lastCandidate = candidate;
      params.assertNotAborted();
      let candidateMetadata = {
        ...stageMetadata,
        ...compactionMeasurement(candidate),
        candidateInputTokens: resolveRequestBudgetInputTokens(candidate.budget),
        sourceRevision: prepared.sourceRevision,
        coveredSourceCount: prepared.coveredSourceCount,
      };
      if (!hasReducedProjection(candidate, current.assessment)) {
        diagnostics.trace("stage", {
          ...candidateMetadata,
          outcome: "discarded_not_reduced",
        });
        const repaired = await prepareProjectionRepair({
          stage,
          messages: current.messages,
          current: current.assessment,
          rejected: candidate,
          preparation: prepared,
          diagnostics,
          assertNotAborted: params.assertNotAborted,
          assess: params.assess,
        });
        if (!repaired) continue;
        prepared = repaired.preparation;
        candidate = repaired.assessment;
        lastCandidate = candidate;
        candidateMetadata = {
          ...stageMetadata,
          ...compactionMeasurement(candidate),
          candidateInputTokens: resolveRequestBudgetInputTokens(candidate.budget),
          sourceRevision: prepared.sourceRevision,
          coveredSourceCount: prepared.coveredSourceCount,
        };
        if (!hasReducedProjection(candidate, current.assessment)) {
          diagnostics.trace("stage", {
            ...candidateMetadata,
            outcome: "discarded_not_reduced",
            projectionRepair: true,
          });
          continue;
        }
      }
      current = { messages: prepared.messages, assessment: candidate };
      retained.push({
        compactionScope: stage.compactionScope,
        preparation: prepared,
      });
      diagnostics.trace("stage", { ...candidateMetadata, outcome: "retained" });
      if (
        canAdmitPreparedCompactedContext(
          current,
          params.assessment,
          retained,
          stages.length,
        )
      )
        break;
    }

    if (
      !canAdmitPreparedCompactedContext(
        current,
        params.assessment,
        retained,
        stages.length,
      )
    ) {
      diagnostics.trace("exhausted", {
        outcome: "exhausted",
        afterInputTokens: resolveRequestBudgetInputTokens(
          current.assessment.budget,
        ),
        reason: resolveCompactionExhaustionReason(
          current.assessment,
          params.assessment,
        ),
      });
      if (onlyEmptyActiveSource)
        throw new Error("context_compaction_sources_empty");
      throw new Error("context_compaction_projection_not_reduced");
    }

    for (const entry of retained) {
      params.assertNotAborted();
      commitInProgress = entry.compactionScope;
      diagnostics.trace("commit", {
        outcome: "started",
        compactionScope: entry.compactionScope,
        scopeId: entry.preparation.scopeId,
        committedScopes: [...committedScopes],
      });
      // The active store commits synchronously; observe the preparation contract's
      // optional promise as well so rejection cannot escape finalization.
      await entry.preparation.commit();
      committedScopes.push(entry.compactionScope);
      commitInProgress = undefined;
      diagnostics.trace("commit", {
        outcome: "committed",
        compactionScope: entry.compactionScope,
        scopeId: entry.preparation.scopeId,
        committedScopes: [...committedScopes],
      });
      params.assertNotAborted();
    }
    params.assertNotAborted();
    diagnostics.trace("admitted", {
      outcome: "admitted",
      committedScopes,
      ...compactionMeasurement(current.assessment),
      afterInputTokens: resolveRequestBudgetInputTokens(
        current.assessment.budget,
      ),
    });
    diagnostics.complete(current.assessment, retained[0]!);
    params.assertNotAborted();
    return current;
  } catch (error: unknown) {
    const primary = params.abortSignal.aborted
      ? params.abortSignal.reason
      : error;
    diagnostics.fail(
      primary,
      resolveCompactionFailureReason(primary, params.abortSignal),
      {
        outcome: isCompactionSteeringSuperseded(primary)
          ? "superseded"
          : "failed",
        activeScope: activeStage?.compactionScope,
        activeScopeId: activeStage?.scopeId,
        committedScopes,
        commitInProgress,
        historyPersistenceOutcome:
          commitInProgress === "session_history"
            ? "unconfirmed"
            : "not_pending",
        afterInputTokens: resolveRequestBudgetInputTokens(
          current.assessment.budget,
        ),
        ...(lastCandidate
          ? {
              candidateInputTokens: resolveRequestBudgetInputTokens(
                lastCandidate.budget,
              ),
            }
          : {}),
        ...(primary === error
          ? {}
          : { secondaryIssueCode: compactionIssueCode(error) }),
      },
    );
    if (isCompactionSteeringSuperseded(primary)) params.assertCurrent();
    throw primary;
  }
}

function isEmptyActiveOnlyPlan(
  stages: readonly ModelStepCompactionStage[],
  stage: ModelStepCompactionStage,
  reason: string,
): boolean {
  if (stages.length !== 1) return false;
  if (stage.compactionScope !== "active_request") return false;
  return reason === "no_eligible_sources";
}

function resolveCompactionExhaustionReason(
  current: RequestMessagesBudgetAssessment,
  original: RequestMessagesBudgetAssessment,
): string {
  if (!current.fits) return "envelope_exceeds_available_input";
  if (!hasReducedProjection(current, original)) return "projection_not_reduced";
  return "reduced_above_trigger";
}

function resolveCompactionFailureReason(
  error: unknown,
  signal: AbortSignal,
): string {
  if (signal.aborted) return "request_aborted";
  if (isCompactionSteeringSuperseded(error)) return "steering_superseded";
  if (isCompactionModelStepTimeout(error)) return "context_compaction_timeout";
  if (compactionIssueCode(error) === "request_context_compaction_required")
    return "context_compaction_controller_unavailable";
  return "semantic_checkpoint_rejected";
}

function isCompactionModelStepTimeout(
  error: unknown,
): error is ModelStepTimeoutError {
  if (!(error instanceof ModelStepTimeoutError)) return false;
  return error.modelStep === "context.compact";
}
