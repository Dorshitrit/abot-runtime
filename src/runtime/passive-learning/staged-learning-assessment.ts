import type { StagedReviewCall } from "./staged-review-call.js";
import type { LearningKnowledgeEntry } from "../long-term-memory/maturation/contracts.js";
import type { LearningReviewSelection } from "./staged-learning-selection.js";
import type { LearningReviewDraft } from "./staged-learning-authoring.js";
import { learningAssignmentEvidence, learningStageObject, runLearningStage, type LearningStagePresentation } from "./staged-learning-stage.js";

export type LearningReviewAssessment = Readonly<{
  ref: string; score: number; certainty: "observed" | "inferred"; reinforced?: boolean;
}>;

export async function assessLearningChanges(selections: readonly LearningReviewSelection[], drafts: readonly LearningReviewDraft[], presentation: LearningStagePresentation, call: StagedReviewCall): Promise<readonly LearningReviewAssessment[]> {
  const writes = drafts.filter(draft => draft.content !== undefined);
  if (!writes.length) return [];
  const scheduled = presentation.references.scheduled;
  return runLearningStage<LearningReviewAssessment>({
    call, stage: "assessment", maximum: writes.length, requiredRefs: writes.map(draft => draft.ref),
    variants: writes.map(draft => {
      const selection = selections.find(item => item.ref === draft.ref)!;
      const target = selection.target === null ? undefined : presentation.references.knowledge.get(selection.target);
      const maximum = maximumAssessmentScore(target, scheduled);
      return learningStageObject({
        ref: { type: "string", enum: [draft.ref] }, score: { type: "integer", minimum: 0, maximum },
        certainty: { type: "string", enum: ["observed", "inferred"] },
        ...(scheduled || selection.action === "create" ? {} : { reinforced: { type: "boolean" } }),
      });
    }),
    instruction: "Assess each fixed knowledge draft against its original evidence. Score 0–100 measures usefulness and support, not probability or promotion permission. Tentative interests should start modestly. Set certainty to observed only for a directly supported fact; possible interests are inferred. Where reinforced is requested, true requires substantive independent new support; unchanged revisits or reanalysis are false. Scheduled reviews have no new evidence and cannot raise candidate scores. Do not rewrite the draft, pick actions or schedule reviews.",
    context: { scheduled, assignments: writes.map(draft => ({ draft,
      ...learningAssignmentEvidence(presentation, selections.find(item => item.ref === draft.ref)!) })) },
  });
}

function maximumAssessmentScore(target: LearningKnowledgeEntry | undefined, scheduled: boolean): number {
  if (!scheduled) return 100;
  if (target?.kind !== "candidate") return 100;
  return target.score ?? 0;
}
