import type { ChatMessage } from "../../model-gateway/types.js";
import {
  resolveRequestBudgetInputTokens,
  type RequestMessagesBudgetAssessment,
} from "../context/request-context-budget.js";
import type {
  ContextCompactionProjectionRepair,
  ModelStepCompactionStage,
  ModelStepContextCompactionPreparation,
} from "./context-compaction-contracts.js";
import type { ContextCompactionDiagnostics } from "./context-compaction-diagnostics.js";
import { assertPreparationStageBinding } from "./context-compaction-stage-plan.js";

export function resolveProjectionRepairReason(params: Readonly<{
  stage: ModelStepCompactionStage;
  projectionReduced: boolean;
  candidateFits: boolean;
  isFinalStage: boolean;
  providerOverflowRecovery?: boolean;
}>): ContextCompactionProjectionRepair["reason"] | undefined {
  if (params.providerOverflowRecovery) return undefined;
  if (!params.projectionReduced) return "projection_not_reduced";
  if (params.candidateFits) return undefined;
  if (!params.isFinalStage) return undefined;
  if (params.stage.compactionScope !== "active_request") return undefined;
  if (!params.stage.supportsProjectionRepair) return undefined;
  return "envelope_exceeds_available_input";
}

/** One retry of an opted-in active stage, from its unchanged canonical input. */
export async function prepareProjectionRepair(params: Readonly<{
  stage: ModelStepCompactionStage;
  reason: ContextCompactionProjectionRepair["reason"];
  messages: readonly ChatMessage[];
  current: RequestMessagesBudgetAssessment;
  rejected: RequestMessagesBudgetAssessment;
  preparation: ModelStepContextCompactionPreparation;
  diagnostics: ContextCompactionDiagnostics;
  assertNotAborted(): void;
  assess(messages: readonly ChatMessage[]): Promise<RequestMessagesBudgetAssessment>;
}>): Promise<Readonly<{
  preparation: ModelStepContextCompactionPreparation;
  assessment: RequestMessagesBudgetAssessment;
}> | undefined> {
  if (params.stage.compactionScope !== "active_request") return undefined;
  if (!params.stage.supportsProjectionRepair) return undefined;
  const originalInputTokens = resolveRequestBudgetInputTokens(params.current.budget);
  const projectionRepair: ContextCompactionProjectionRepair = Object.freeze({
    reason: params.reason,
    originalInputTokens,
    candidateInputTokens: resolveRequestBudgetInputTokens(params.rejected.budget),
    targetInputTokens: Math.max(0, Math.min(
      originalInputTokens - 1,
      params.current.budget.compactionTriggerInputTokens - 1,
      params.current.budget.availableInputTokens,
    )),
  });
  const metadata = {
    compactionScope: params.stage.compactionScope,
    scopeId: params.stage.scopeId,
    ...projectionRepair,
  };
  params.assertNotAborted();
  params.diagnostics.trace("projection_repair", { ...metadata, outcome: "started" });
  const onProgress = params.diagnostics.observePreparation(params.stage, 2);
  const outcome = await params.stage.prepare(params.messages, { projectionRepair, onProgress });
  params.assertNotAborted();
  if (outcome.kind === "unavailable") {
    params.diagnostics.trace("projection_repair", {
      ...metadata,
      outcome: "unavailable",
      unavailableReason: outcome.reason,
    });
    return undefined;
  }
  const prepared = outcome.preparation;
  assertPreparationStageBinding(params.stage, prepared);
  assertUnchangedRepairSourceBinding(params.preparation, prepared);
  params.assertNotAborted();
  onProgress({ step: "checking" });
  const assessment = await params.assess(prepared.messages);
  params.assertNotAborted();
  params.diagnostics.trace("projection_repair", {
    ...metadata,
    outcome: "prepared",
    repairedInputTokens: resolveRequestBudgetInputTokens(assessment.budget),
  });
  return { preparation: prepared, assessment };
}

function assertUnchangedRepairSourceBinding(
  original: ModelStepContextCompactionPreparation,
  repaired: ModelStepContextCompactionPreparation,
): void {
  if (original.sourceRevision !== repaired.sourceRevision)
    throw new Error("context_compaction_repair_source_binding_changed");
  if (original.coveredSourceCount !== repaired.coveredSourceCount)
    throw new Error("context_compaction_repair_source_binding_changed");
}
