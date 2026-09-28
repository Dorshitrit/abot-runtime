import { MAX_LEARNING_DECISIONS } from "../long-term-memory/maturation/decisions.js";
import type { StagedReviewCall } from "./staged-review-call.js";
import { learningStageObject, runLearningStage, type LearningStagePresentation } from "./staged-learning-stage.js";

export type LearningReviewIdea = Readonly<{ ref: string; objective: string; evidence: readonly string[] }>;
export type LearningReviewMatch = LearningReviewIdea & Readonly<{ target: string | null }>;
export type LearningReviewSelection = LearningReviewMatch & Readonly<{
  action: "create" | "update" | "remove" | "merge"; sources: readonly string[];
}>;

/** Discovery sees activity only: it does not manage existing knowledge or choose mutations. */
export async function discoverLearningIdeas(presentation: LearningStagePresentation, call: StagedReviewCall): Promise<readonly LearningReviewIdea[]> {
  if (presentation.references.scheduled) return presentation.references.targetRefs.slice(0, MAX_LEARNING_DECISIONS).map((target, index) => ({
    ref: `d${index + 1}`, objective: presentation.references.knowledge.get(target)!.content, evidence: [],
  }));
  if (!presentation.observations.length) return [];
  return runLearningStage<LearningReviewIdea>({
    call, stage: "discovery", maximum: MAX_LEARNING_DECISIONS,
    variants: [learningStageObject({
      ref: { type: "string", enum: Array.from({ length: MAX_LEARNING_DECISIONS }, (_, index) => `d${index + 1}`) },
      objective: { type: "string", maxLength: 1000 },
      evidence: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", enum: [...presentation.references.evidence.keys()] } },
    })],
    instruction: "Identify a few distinct useful ideas about the user supported by activity. A possible interest is welcome as a tentative candidate; it need not already be a lasting preference or a user request. A visit alone does not prove intent. Omit generic UI noise, unchanged repeats without new meaning, secrets and unsupported personal claims. Write a short tentative objective and cite its observation references. Use a different d reference for each idea. Return no ideas when nothing is useful. Do not choose actions, targets or scores.",
    context: { observations: presentation.observations },
    validate: rows => { if (rows.some(row => !row.objective.trim())) throw new Error("learning_content_invalid"); },
  });
}

/** Matching chooses one relationship at a time; the runtime owns identity and grouping. */
export async function matchLearningIdeas(ideas: readonly LearningReviewIdea[], presentation: LearningStagePresentation, call: StagedReviewCall): Promise<readonly LearningReviewMatch[]> {
  if (presentation.references.scheduled) return ideas.map((idea, index) => ({
    ...idea, target: presentation.references.targetRefs[index]!,
  }));
  if (!presentation.knowledge.entries.length) return ideas.map(idea => ({ ...idea, target: null }));
  const matches = await runLearningStage<Readonly<{ ref: string; match: string }>>({
    call, stage: "matching", maximum: ideas.length,
    variants: [learningStageObject({
      ref: { type: "string", enum: ideas.map(idea => idea.ref) },
      match: { type: "string", enum: ["new", "ignore", ...presentation.references.targetRefs] },
    })],
    instruction: "For each tentative idea choose the matching mutable knowledge reference if it describes the same topic, new if it deserves a separate candidate, or ignore if redundant or unsupported. Protected entries are reference-only: do not duplicate or change them. Omitted ideas are ignored. Only choose the relationship; do not decide a mutation, write content, or set scores.",
    context: { ideas, knowledge: presentation.knowledge.entries, observations: presentation.observations },
  });
  const grouped: LearningReviewMatch[] = [];
  for (const row of matches) {
    const idea = ideas.find(item => item.ref === row.ref)!;
    if (row.match === "ignore") continue;
    const target = row.match === "new" ? null : row.match;
    const previous = target === null ? undefined : grouped.find(item => item.target === target);
    if (!previous) { grouped.push({ ...idea, target }); continue; }
    const index = grouped.indexOf(previous);
    grouped[index] = { ...previous, objective: previous.objective + "\n" + idea.objective,
      evidence: [...new Set([...previous.evidence, ...idea.evidence])].slice(0, 16) };
  }
  return grouped;
}
