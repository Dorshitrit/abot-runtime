import { traceDebug } from "../observability/debug-logger.js";
import { createLearningReviewPresentation, type LearningReviewInput } from "./review-references.js";
import { decodeLearningReviewDecisions } from "./review-decision-adapter.js";
import { createLearningReviewFormat } from "./review-response-format.js";
import type { StagedReviewCall } from "./staged-review-call.js";
import { discoverLearningIdeas, matchLearningIdeas } from "./staged-learning-selection.js";
import { chooseLearningChanges } from "./staged-learning-changes.js";
import { authorLearningChanges } from "./staged-learning-authoring.js";
import { assessLearningChanges } from "./staged-learning-assessment.js";
import { scheduleLearningChanges } from "./staged-learning-timing.js";

export const MAX_STAGED_LEARNING_CALLS = 18;

/** Stage outputs remain proposals; the existing repository owns the single atomic apply. */
export async function runStagedLearningReview(input: LearningReviewInput, call: StagedReviewCall) {
  const presentation = createLearningReviewPresentation(input);
  const ideas = await discoverLearningIdeas(presentation, call);
  if (!ideas.length) return [];
  const matches = await matchLearningIdeas(ideas, presentation, call);
  if (!matches.length) return [];
  const selections = await chooseLearningChanges(matches, presentation, call);
  if (!selections.length) return [];
  const drafts = await authorLearningChanges(selections, presentation, call);
  if (!drafts.length) return [];
  const assessments = await assessLearningChanges(selections, drafts, presentation, call);
  const deadlines = await scheduleLearningChanges(drafts, call);
  const wire = drafts.map(draft => {
    const selection = selections.find(item => item.ref === draft.ref)!;
    const assessment = assessments.find(item => item.ref === draft.ref);
    const { ref: _ref, ...authored } = draft;
    const write = selection.action !== "remove";
    return { ...authored, action: selection.action,
      ...(selection.target === null ? {} : { target: selection.target }),
      ...(selection.action === "merge" ? { sources: selection.sources } : {}),
      ...(presentation.references.scheduled ? {} : { evidence: selection.evidence }),
      ...(write ? { score: assessment!.score, certainty: assessment!.certainty, reconsiderAt: deadlines.get(draft.ref) ?? null } : {}),
      ...(canReinforce(selection.action, presentation.references.scheduled) ? { reinforced: assessment!.reinforced } : {}),
    };
  });
  const decisions = decodeLearningReviewDecisions(JSON.stringify({ decisions: wire }), presentation.references,
    createLearningReviewFormat(presentation.references));
  const actionCounts = { create: 0, update: 0, merge: 0, remove: 0 };
  for (const decision of decisions) actionCounts[decision.action]++;
  traceDebug("runtime.passive_learning", "review.output_accepted", {
    requestId: `learning:${input.batchId}`, batchId: input.batchId,
    modelProfileId: input.modelProfileId, method: "staged", decisionCount: decisions.length, actionCounts,
  });
  return decisions;
}

function canReinforce(action: string, scheduled: boolean): boolean {
  if (scheduled) return false;
  return action === "update" || action === "merge";
}
