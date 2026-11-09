import type { SparkHomeSnapshot } from "../contracts.js";
import { AUTHORING_CONTEXT_LIMITS as limits } from "./contracts.js";
import type { CapturedHistoryRecords } from "./history-records.js";
import type { CapturedMemoryRecords } from "./memory-records.js";
import { contextFailure } from "./projection.js";
import { projectPlanningMemories } from "./planning-memory.js";
import { projectPlanningHistory } from "./planning-history.js";
import { projectPlanningResourceIndex, type ResourceIndex } from "./resources.js";

function planningRelevance(memories: CapturedMemoryRecords, history: CapturedHistoryRecords, requestId: string) {
  const memoryProjection = projectPlanningMemories(memories);
  const historyProjection = projectPlanningHistory(history, requestId);
  return {
    authority: "passive_background_with_provenance_not_selected_interests_or_current_intent",
    memories: memoryProjection.section, history: historyProjection,
    sourceStatus: { ...memoryProjection.sourceStatus, history: historyProjection.status },
  };
}

export type SparkHomePlanningReference = Readonly<{
  kind: "spark_home_planning_reference_v1";
  authority: "passive_reference";
  purpose: string;
  provenance: string;
  applicability: "this_requested_spark_home_only";
  addsUserIntent: false;
  grantsActionAuthority: false;
  establishesCompletion: false;
  historicalRequestsAreNotPendingWork: true;
  candidatesAreUnconfirmed: true;
  capturedAt: string;
  screen: Readonly<{ revision: number; hasScreen: boolean; updatedAt: string | null }>;
  relevance: ReturnType<typeof planningRelevance>;
  resources: ReturnType<typeof projectPlanningResourceIndex>;
  characterLimit: number;
}>;

/** Plan projection uses the same captured source records as HTML, without prior HTML. */
export function projectSparkHomePlanningContext(input: Readonly<{
  screen: SparkHomeSnapshot; memories: CapturedMemoryRecords; history: CapturedHistoryRecords;
  resources: ResourceIndex; requestId: string; now: Date;
}>): SparkHomePlanningReference {
  const reference: SparkHomePlanningReference = {
    kind: "spark_home_planning_reference_v1", authority: "passive_reference",
    purpose: "Background for the requested SPARK HOME; explicit personal requirements remain authoritative.",
    provenance: "This Runtime environment's saved memories, passive learning, recent conversations and indexed Resources metadata.",
    applicability: "this_requested_spark_home_only", addsUserIntent: false, grantsActionAuthority: false,
    establishesCompletion: false, historicalRequestsAreNotPendingWork: true, candidatesAreUnconfirmed: true,
    capturedAt: input.now.toISOString(),
    screen: { revision: input.screen.revision, hasScreen: input.screen.html !== null, updatedAt: input.screen.updatedAt },
    relevance: planningRelevance(input.memories, input.history, input.requestId),
    resources: projectPlanningResourceIndex(input.resources), characterLimit: limits.planningCharacters,
  };
  const serialized = JSON.stringify(reference);
  if (serialized.length > limits.planningCharacters)
    contextFailure("planning_limit", "SPARK HOME planning context exceeds its bounded reference limit.");
  return JSON.parse(serialized) as SparkHomePlanningReference;
}
