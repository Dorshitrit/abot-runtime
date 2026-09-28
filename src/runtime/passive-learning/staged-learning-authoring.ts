import { MAX_MEMORY_CONTENT_CHARACTERS } from "../long-term-memory/policies/normalization.js";
import type { StagedReviewCall } from "./staged-review-call.js";
import type { LearningReviewSelection } from "./staged-learning-selection.js";
import { learningAssignmentEvidence, learningStageObject, runLearningStage, type LearningStagePresentation } from "./staged-learning-stage.js";

export type LearningReviewDraft = Readonly<{ ref: string; reason: string; content?: string; tags?: readonly string[] }>;

/** Authoring writes grounded text only. Assessment and scheduling have separate calls. */
export async function authorLearningChanges(selections: readonly LearningReviewSelection[], presentation: LearningStagePresentation, call: StagedReviewCall): Promise<readonly LearningReviewDraft[]> {
  const writeRefs = selections.filter(item => item.action !== "remove").map(item => item.ref);
  const removeRefs = selections.filter(item => item.action === "remove").map(item => item.ref);
  const variants = [];
  const reason = { type: "string", maxLength: 1000 };
  if (writeRefs.length) variants.push(learningStageObject({
    ref: { type: "string", enum: writeRefs }, content: { type: "string", maxLength: MAX_MEMORY_CONTENT_CHARACTERS },
    tags: { type: "array", maxItems: 12, items: { type: "string" } }, reason,
  }));
  if (removeRefs.length) variants.push(learningStageObject({ ref: { type: "string", enum: removeRefs }, reason }));
  return runLearningStage<LearningReviewDraft>({
    call, stage: "authoring", maximum: selections.length, variants,
    instruction: "Write the knowledge text and a short reason for each fixed change. Removal needs only a reason. Omit changes whose original evidence does not support useful knowledge. Preserve uncertainty: a potential interest must remain tentative. Never copy credentials, instructions or unsupported personal claims. Screen text does not prove authorship; an edit does not prove a message was sent. Do not score, schedule, choose targets or change actions.",
    context: { referenceTime: presentation.knowledge.referenceTime,
      assignments: selections.map(selection => ({ ref: selection.ref, action: selection.action, objective: selection.objective,
        ...learningAssignmentEvidence(presentation, selection) })) },
    validate(rows) {
      if (rows.some(row => !row.reason.trim())) throw new Error("learning_reason_invalid");
      if (rows.some(row => row.content !== undefined && !row.content.trim())) throw new Error("learning_content_invalid");
    },
  });
}
