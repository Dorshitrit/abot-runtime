import type { LearningKnowledgeContext, LearningMemoryDecision, LearningReviewCause } from "./contracts.js";
import { isMemoryCandidateWithinLimits, normalizeMemoryCandidate, MAX_MEMORY_CONTENT_CHARACTERS } from "../policies/normalization.js";
import { containsSensitiveMemoryCandidateData, containsSensitiveMemoryData } from "../policies/sensitive-data.js";
import { assertScheduledReviewCause, isScheduledKnowledgeReview } from "./scheduled-review.js";
import { readLearningDecisionEnvelope } from "./decision-envelope.js";
import { assertConversationReviewCause } from "./conversation-evidence.js";

export const MAX_LEARNING_DECISIONS = 12;

export function parseLearningDecisions(text: string): readonly LearningMemoryDecision[] {
  const decisions = readLearningDecisionEnvelope(text, MAX_LEARNING_DECISIONS);
  for (const decision of decisions) {
    if (isObject(decision) && typeof decision.content === "string" && decision.content.length > MAX_MEMORY_CONTENT_CHARACTERS)
      throw new Error("learning_content_exceeds_limit");
  }
  return normalizeLearningDecisions(decisions);
}

export function normalizeLearningDecisions(decisions: readonly unknown[]): readonly LearningMemoryDecision[] {
  if (!Array.isArray(decisions) || decisions.length > MAX_LEARNING_DECISIONS) throw new Error("learning_decisions_invalid");
  return Object.freeze(decisions.map(parseDecision));
}

export function assertLearningDecisionBindings(
  decisions: readonly LearningMemoryDecision[],
  context: LearningKnowledgeContext,
  observationIds: readonly string[],
  now: number,
  cause?: LearningReviewCause,
): void {
  assertScheduledReviewCause(cause);
  assertConversationReviewCause(cause, now);
  if (decisions.length > MAX_LEARNING_DECISIONS) throw new Error("learning_decisions_invalid");
  const touched = new Set<string>();
  for (const raw of decisions) {
    const decision = parseDecision(raw);
    if (isScheduledKnowledgeReview(cause)) assertScheduledDecision(decision, context, cause);
    if (cause?.kind === "conversation_memory_review" && decision.observationIds.length)
      throw new Error("learning_decision_source_unknown");
    if (!cause && (!decision.observationIds.length || decision.observationIds.some((id) => !observationIds.includes(id))))
      throw new Error("learning_decision_source_unknown");
    if (decision.reconsiderAt && Date.parse(decision.reconsiderAt) <= now && !preservesBoundReviewDeadline(decision, context, cause))
      throw new Error("learning_reconsideration_not_future");
    if (decision.action === "create") {
      if (decision.targetKind !== "candidate" || decision.targetId !== null || decision.targetVersion !== null)
        throw new Error("learning_create_target_invalid");
    } else {
      const target = context.entries.find((entry) => entry.kind === decision.targetKind && entry.id === decision.targetId);
      if (!target || target.version !== decision.targetVersion) throw new Error("learning_decision_target_unknown");
      if (!target.mutable) throw new Error("learning_memory_protected");
      touch(touched, `${target.kind}:${target.id}`);
    }
    if (decision.action !== "merge" && decision.mergedCandidateIds.length)
      throw new Error("learning_merge_binding_invalid");
    if (decision.action === "merge" && !decision.mergedCandidateIds.length)
      throw new Error("learning_merge_binding_invalid");
    for (const id of decision.mergedCandidateIds) {
      const source = context.entries.find((entry) => entry.kind === "candidate" && entry.id === id);
      if (!source) throw new Error("learning_merge_source_unknown");
      touch(touched, `candidate:${id}`);
    }
  }
}

function preservesBoundReviewDeadline(decision: LearningMemoryDecision, context: LearningKnowledgeContext, cause?: LearningReviewCause): boolean {
  if (isScheduledKnowledgeReview(cause) || decision.action === "create") return false;
  return context.entries.some(entry => entry.kind === decision.targetKind && entry.id === decision.targetId &&
    entry.version === decision.targetVersion && entry.reconsiderAt === decision.reconsiderAt);
}

function assertScheduledDecision(decision: LearningMemoryDecision, context: LearningKnowledgeContext, cause: Extract<LearningReviewCause, { kind: "scheduled_knowledge_review" }>): void {
  if (decision.action !== "update" && decision.action !== "remove") throw new Error("learning_review_action_invalid");
  if (decision.observationIds.length || decision.reinforced) throw new Error("learning_review_cannot_reinforce");
  const due = cause.dueEntries.find((entry) => entry.kind === decision.targetKind && entry.id === decision.targetId && entry.version === decision.targetVersion);
  if (!due) throw new Error("learning_review_target_not_due");
  const target = context.entries.find((entry) => entry.kind === due.kind && entry.id === due.id);
  if (!target) throw new Error("learning_decision_target_unknown");
  if (decision.action === "remove" || target.kind === "memory") return;
  if (decision.score > (target.score ?? 0)) throw new Error("learning_review_cannot_raise_score");
}

function touch(touched: Set<string>, id: string): void {
  if (touched.has(id)) throw new Error("learning_decision_target_repeated");
  touched.add(id);
}

function parseDecision(raw: unknown): LearningMemoryDecision {
  if (!isObject(raw)) throw new Error("learning_decision_invalid");
  const { action, targetKind, targetId, targetVersion, reconsiderAt, certainty } = raw;
  if (action !== "create" && action !== "update" && action !== "remove" && action !== "merge") throw new Error("learning_action_invalid");
  if (targetKind !== "candidate" && targetKind !== "memory") throw new Error("learning_target_kind_invalid");
  if (!isNullableText(targetId) || !isNullableText(targetVersion)) throw new Error("learning_target_invalid");
  if (!isNullableText(reconsiderAt) || (reconsiderAt !== null && !Number.isFinite(Date.parse(reconsiderAt)))) throw new Error("learning_reconsideration_invalid");
  if (certainty !== "observed" && certainty !== "inferred") throw new Error("learning_certainty_invalid");
  if (typeof raw.reinforced !== "boolean") throw new Error("learning_reinforcement_invalid");
  if (typeof raw.score !== "number" || !Number.isInteger(raw.score) || raw.score < 0 || raw.score > 100) throw new Error("learning_score_invalid");
  if (typeof raw.content !== "string" || (action !== "remove" && !raw.content.trim())) throw new Error("learning_content_invalid");
  if (typeof raw.reason !== "string" || !raw.reason.trim() || raw.reason.length > 1000) throw new Error("learning_reason_invalid");
  const tags = stringList(raw.tags, 12);
  if (!isMemoryCandidateWithinLimits({ content: raw.content, tags })) throw new Error("learning_content_exceeds_limit");
  if (containsSensitiveMemoryCandidateData({ content: raw.content, tags }) || containsSensitiveMemoryData(raw.reason)) throw new Error("learning_content_sensitive");
  const candidate = normalizeMemoryCandidate({ content: raw.content, tags }) ?? { content: "", tags: [] };
  return Object.freeze({
    action, targetKind, targetId, targetVersion, reconsiderAt, certainty,
    ...candidate, score: raw.score, reason: raw.reason.trim(), reinforced: raw.reinforced,
    mergedCandidateIds: stringList(raw.mergedCandidateIds, 12), observationIds: stringList(raw.observationIds, 16),
  });
}
function stringList(value: unknown, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error("learning_decision_list_invalid");
  return Object.freeze([...new Set(value as string[])]);
}
function isNullableText(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim().length > 0 && value.length <= 128);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
