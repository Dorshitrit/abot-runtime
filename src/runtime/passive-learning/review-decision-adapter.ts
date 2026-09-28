import type { ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import type { LearningKnowledgeEntry, LearningMemoryDecision } from "../long-term-memory/maturation/contracts.js";
import { readLearningDecisionEnvelope } from "../long-term-memory/maturation/decision-envelope.js";
import { MAX_LEARNING_DECISIONS, normalizeLearningDecisions } from "../long-term-memory/maturation/decisions.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import type { LearningReviewReferences } from "./review-references.js";
import { learningFailureReason } from "./status-projection.js";

type ReviewAction = LearningMemoryDecision["action"];
type ReviewDiagnostics = Readonly<{
  stage: "shape" | "target_binding" | "evidence_binding" | "domain_validation";
  decisionIndex?: number;
  action?: ReviewAction | "unknown";
}>;

/** Diagnostics contain only fixed stages, a bounded index and a known action. */
export class LearningReviewOutputError extends Error {
  constructor(reason: string, readonly diagnostics: ReviewDiagnostics) {
    super(reason);
    this.name = "LearningReviewOutputError";
    Object.freeze(diagnostics);
  }
}

/** Resolve model aliases into passive proposals; repository apply still owns commit authority. */
export function decodeLearningReviewDecisions(
  text: string,
  references: LearningReviewReferences,
  format: ModelGatewayJsonSchemaFormat,
): readonly LearningMemoryDecision[] {
  const decisions = readLearningDecisionEnvelope(text, MAX_LEARNING_DECISIONS);
  const bound = decisions.map((decision, index) => bindReviewDecision(decision, references, index));
  assertReviewWireShape(text, decisions, format);
  return Object.freeze(bound.map((decision, index) => {
    try {
      return normalizeLearningDecisions([decision])[0]!;
    } catch (error) {
      const safeReason = learningFailureReason(error);
      const reason = safeReason === "learning_failed" ? "learning_review_output_contract_invalid" : safeReason;
      throw new LearningReviewOutputError(reason, { stage: "domain_validation", decisionIndex: index,
        action: knownReviewAction(decision.action) });
    }
  }));
}

function bindReviewDecision(raw: unknown, references: LearningReviewReferences, index: number): Record<string, unknown> {
  if (!isReviewDecisionObject(raw)) throw shapeError(index, "unknown");
  const action = knownReviewAction(raw.action);
  if (action === "unknown") throw new LearningReviewOutputError("learning_action_invalid", {
    stage: "shape", decisionIndex: index, action,
  });
  assertReviewActionAllowed(action, references, index);
  const observationIds = references.scheduled ? [] : resolveReviewEvidence(raw.evidence, references, index, action);
  if (action === "create") return {
    ...reviewContent(raw), action, targetKind: "candidate", targetId: null, targetVersion: null,
    observationIds, reinforced: false, mergedCandidateIds: [],
  };
  const target = resolveReviewTarget(raw.target, references, index, action);
  const binding = { action, targetKind: target.kind, targetId: target.id, targetVersion: target.version, observationIds };
  if (action === "remove") return {
    ...binding, content: "", tags: [], score: target.score ?? 0, reason: raw.reason,
    certainty: target.certainty === "observed" ? "observed" : "inferred",
    reinforced: false, reconsiderAt: null, mergedCandidateIds: [],
  };
  return { ...binding, ...reviewContent(raw), reinforced: references.scheduled ? false : raw.reinforced,
    mergedCandidateIds: action === "merge" ? resolveMergeSources(raw.sources, references, index, action) : [],
  };
}

function reviewContent(raw: Record<string, unknown>): Record<string, unknown> {
  return { content: raw.content, tags: raw.tags, score: raw.score, reason: raw.reason,
    certainty: raw.certainty, reconsiderAt: raw.reconsiderAt };
}

function assertReviewActionAllowed(action: ReviewAction, references: LearningReviewReferences, index: number): void {
  if (!references.scheduled) return;
  if (action === "update" || action === "remove") return;
  throw new LearningReviewOutputError("learning_review_action_invalid", { stage: "target_binding", decisionIndex: index, action });
}

function resolveReviewTarget(raw: unknown, references: LearningReviewReferences, index: number, action: ReviewAction): LearningKnowledgeEntry {
  if (typeof raw !== "string") throw shapeError(index, action);
  const diagnostics = { stage: "target_binding", decisionIndex: index, action } as const;
  const target = references.knowledge.get(raw);
  if (!target) throw new LearningReviewOutputError("learning_decision_target_unknown", diagnostics);
  if (!target.mutable) throw new LearningReviewOutputError("learning_memory_protected", diagnostics);
  if (!isReviewTargetDue(target, references)) throw new LearningReviewOutputError("learning_review_target_not_due", diagnostics);
  if (!references.targetRefs.includes(raw)) throw new LearningReviewOutputError("learning_decision_target_unknown", diagnostics);
  return target;
}

function isReviewTargetDue(target: LearningKnowledgeEntry, references: LearningReviewReferences): boolean {
  if (references.cause?.kind !== "scheduled_knowledge_review") return true;
  return references.cause?.dueEntries.some(entry =>
    entry.kind === target.kind && entry.id === target.id && entry.version === target.version) === true;
}

function resolveReviewEvidence(raw: unknown, references: LearningReviewReferences, index: number, action: ReviewAction): readonly string[] {
  if (!isReviewReferenceList(raw, 16)) throw shapeError(index, action);
  return raw.map(alias => {
    const id = references.evidence.get(alias);
    if (!id || !references.observationIds.includes(id)) throw new LearningReviewOutputError("learning_decision_source_unknown", {
      stage: "evidence_binding", decisionIndex: index, action,
    });
    return id;
  });
}

function resolveMergeSources(raw: unknown, references: LearningReviewReferences, index: number, action: ReviewAction): readonly string[] {
  if (!isReviewReferenceList(raw, 12)) throw shapeError(index, action);
  return raw.map(alias => {
    const source = references.knowledge.get(alias);
    const diagnostics = { stage: "target_binding", decisionIndex: index, action } as const;
    if (!source || source.kind !== "candidate") throw new LearningReviewOutputError("learning_merge_source_unknown", diagnostics);
    if (!source.mutable) throw new LearningReviewOutputError("learning_memory_protected", diagnostics);
    if (!references.mergeRefs.includes(alias)) throw new LearningReviewOutputError("learning_merge_source_unknown", diagnostics);
    return source.id;
  });
}

function assertReviewWireShape(text: string, decisions: readonly unknown[], format: ModelGatewayJsonSchemaFormat): void {
  for (const [index, decision] of decisions.entries()) {
    if (validateJsonSchemaValue(format, { decisions: [decision] })) {
      const action = isReviewDecisionObject(decision) ? knownReviewAction(decision.action) : "unknown";
      throw shapeError(index, action);
    }
  }
  // Validate the original root too: rebuilding it would silently discard undeclared fields.
  if (validateJsonSchemaValue(format, JSON.parse(text))) throw new LearningReviewOutputError(
    "learning_review_output_contract_invalid", { stage: "shape" });
}

function shapeError(index: number, action: ReviewAction | "unknown"): LearningReviewOutputError {
  return new LearningReviewOutputError("learning_review_output_contract_invalid", { stage: "shape", decisionIndex: index, action });
}
function knownReviewAction(value: unknown): ReviewAction | "unknown" {
  if (value === "create" || value === "update" || value === "merge" || value === "remove") return value;
  return "unknown";
}
function isReviewDecisionObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  return !Array.isArray(value);
}
function isReviewReferenceList(value: unknown, maximum: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  return value.every(item => typeof item === "string");
}
