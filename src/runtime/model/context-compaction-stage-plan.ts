import type {
  ModelStepCompactionStage,
  ModelStepContextCompactionPreparation,
} from "./context-compaction-contracts.js";

export function assertCompactionStagePlan(
  stages: readonly ModelStepCompactionStage[],
): void {
  if (stages.length > 2)
    throw new Error("context_compaction_stage_plan_invalid");
  const scopes = new Set<string>();
  const scopeIds = new Set<string>();
  for (const [index, stage] of stages.entries()) {
    if (!stage.scopeId.trim())
      throw new Error("context_compaction_stage_plan_invalid");
    if (scopes.has(stage.compactionScope))
      throw new Error("context_compaction_stage_plan_invalid");
    if (scopeIds.has(stage.scopeId))
      throw new Error("context_compaction_stage_plan_invalid");
    if (isHistoryStageOutOfOrder(stage, index))
      throw new Error("context_compaction_stage_plan_invalid");
    scopes.add(stage.compactionScope);
    scopeIds.add(stage.scopeId);
  }
}

function isHistoryStageOutOfOrder(
  stage: ModelStepCompactionStage,
  index: number,
): boolean {
  if (stage.compactionScope !== "session_history") return false;
  return index !== 0;
}

export function assertPreparationStageBinding(
  stage: ModelStepCompactionStage,
  prepared: ModelStepContextCompactionPreparation,
): void {
  if (stage.scopeId === prepared.scopeId) return;
  throw new Error("context_compaction_stage_scope_mismatch");
}
