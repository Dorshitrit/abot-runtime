import type { LearningKnowledgeContext, LearningKnowledgeEntry, LearningReviewCause } from "../long-term-memory/maturation/contracts.js";
import type { PassiveLearningModel } from "./contracts.js";

export type LearningReviewInput = Parameters<NonNullable<PassiveLearningModel["review"]>>[0];
export type LearningReviewReferences = Readonly<{
  context: LearningKnowledgeContext;
  cause?: LearningReviewCause;
  observationIds: readonly string[];
  knowledge: ReadonlyMap<string, LearningKnowledgeEntry>;
  evidence: ReadonlyMap<string, string>;
  targetRefs: readonly string[];
  mergeRefs: readonly string[];
  scheduled: boolean;
}>;

/** Private call-local binding table. Aliases never enter persistent memory or receipts. */
export function createLearningReviewPresentation(input: LearningReviewInput) {
  const context = structuredClone(input.context);
  const cause = input.cause ? structuredClone(input.cause) : undefined;
  const observations = structuredClone(input.observations);
  const scheduled = cause?.kind === "scheduled_knowledge_review";
  const knowledge = new Map(context.entries.map((entry, index) => [`k${index + 1}`, Object.freeze(entry)] as const));
  const evidence = new Map(observations.map(({ id }, index) => [`o${index + 1}`, id]));
  const evidenceRefs = new Map([...evidence].map(([ref, id]) => [id, ref]));
  const targetRefs = [...knowledge].filter(([, entry]) => isReviewTargetAllowed(entry, cause)).map(([ref]) => ref);
  const mergeRefs = targetRefs.filter((ref) => !scheduled && knowledge.get(ref)!.kind === "candidate");
  const references: LearningReviewReferences = Object.freeze({
    context, cause, observationIds: observations.map(({ id }) => id),
    knowledge, evidence, targetRefs, mergeRefs, scheduled,
  });
  return Object.freeze({
    references,
    knowledge: {
      ...context, kind: "learning_review_knowledge_v2",
      entries: [...knowledge].map(([ref, { id: _id, version: _version, ...entry }]) => ({ ref, ...entry })),
    },
    observations: observations.map((observation, index) => ({
      ref: `o${index + 1}`, timestamp: observation.timestamp, content: observation.content,
      source: { app: observation.source.app, title: observation.source.title, url: observation.source.url },
      kind: observation.kind, extraction: observation.extraction,
      coverage: observation.coverage, coverageReason: observation.coverageReason,
      ...(isRepeatedObservation(observation) ? {
        revisited: true, revisits: observation.revisitsObservationId ? evidenceRefs.get(observation.revisitsObservationId) : undefined,
      } : {}),
    })),
  });
}

function isRepeatedObservation(observation: LearningReviewInput["observations"][number]): boolean {
  if (observation.revisitsObservationId) return true;
  return observation.revisit?.contentUnchanged === true;
}

function isReviewTargetAllowed(entry: LearningKnowledgeEntry, cause: LearningReviewCause | undefined): boolean {
  if (!entry.mutable) return false;
  if (cause?.kind !== "scheduled_knowledge_review") return true;
  return cause.dueEntries.some((due) => due.kind === entry.kind && due.id === entry.id && due.version === entry.version);
}
