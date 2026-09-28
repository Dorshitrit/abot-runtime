import type { StagedReviewCall } from "./staged-review-call.js";
import { learningAssignmentEvidence, learningStageObject, runLearningStage, type LearningStagePresentation } from "./staged-learning-stage.js";
import type { LearningReviewMatch, LearningReviewSelection } from "./staged-learning-selection.js";

type ChangeChoice = Readonly<{ ref: string; change: "keep" | "revise" | "remove" | "combine" }>;

/** Matching has already fixed targets. This stage only decides whether their knowledge should change. */
export async function chooseLearningChanges(matches: readonly LearningReviewMatch[], presentation: LearningStagePresentation, call: StagedReviewCall): Promise<readonly LearningReviewSelection[]> {
  const existing = matches.filter(match => match.target !== null);
  const selected: LearningReviewSelection[] = matches.filter(match => match.target === null).map(match => ({
    ...match, action: "create", sources: [],
  }));
  if (!existing.length) return selected;
  const choices = await runLearningStage<ChangeChoice>({
    call, stage: "change", maximum: existing.length,
    variants: existing.map(match => learningStageObject({
      ref: { type: "string", enum: [match.ref] },
      change: { type: "string", enum: ["keep", "revise", "remove", ...(availableMergeSources(match, matches, presentation).length ? ["combine"] : [])] },
    })),
    instruction: "For each bound entry choose keep, revise, or remove. Choose combine only when equivalent candidate entries should be consolidated into this target. Keep means no useful new evidence or change. Revise can add substantive support to a candidate even without rewriting its meaning. Remove requires evidence that the entry is no longer useful or valid. A passing date alone never proves an event happened. Omitted entries are kept. Do not select targets or sources, write replacement content, or score anything.",
    context: { referenceTime: presentation.knowledge.referenceTime, scheduled: presentation.references.scheduled,
      assignments: existing.map(match => ({ ref: match.ref, objective: match.objective,
        ...learningAssignmentEvidence(presentation, match),
        possibleMergeSources: availableMergeSources(match, matches, presentation).map(ref => presentation.knowledge.entries.find(entry => entry.ref === ref)),
      })) },
  });
  const usedSources = new Set<string>();
  for (const choice of choices) {
    if (choice.change === "keep") continue;
    const match = existing.find(item => item.ref === choice.ref)!;
    if (choice.change !== "combine") {
      selected.push({ ...match, action: choice.change === "remove" ? "remove" : "update", sources: [] });
      continue;
    }
    const allowed = availableMergeSources(match, matches, presentation).filter(source => !usedSources.has(source));
    if (!allowed.length) continue;
    const rows = await runLearningStage<Readonly<{ ref: string; sources: readonly string[] }>>({
      call, stage: `merge_${match.ref}`, maximum: 1,
      variants: [learningStageObject({ ref: { type: "string", enum: [match.ref] },
        sources: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", enum: allowed } } })],
      instruction: "Select equivalent candidate sources to combine into the fixed target. Only select supplied references. Return an empty decisions array if no source is equivalent. Do not change the target, write merged content, or set scores.",
      context: { target: learningAssignmentEvidence(presentation, match).target,
        candidates: presentation.knowledge.entries.filter(entry => allowed.includes(entry.ref)) },
    });
    const sources = rows[0]?.sources;
    if (!sources?.length) continue;
    sources.forEach(source => usedSources.add(source));
    selected.push({ ...match, action: "merge", sources: [...new Set(sources)] });
  }
  return selected;
}

function availableMergeSources(match: LearningReviewMatch, matches: readonly LearningReviewMatch[], presentation: LearningStagePresentation): readonly string[] {
  if (presentation.references.scheduled) return [];
  const occupied = new Set(matches.flatMap(item => item.target === null ? [] : [item.target]));
  return presentation.references.mergeRefs.filter(source => source !== match.target && !occupied.has(source));
}
