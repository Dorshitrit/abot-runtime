import { createHash } from "node:crypto";
import type { LongTermMemoryRepositorySnapshot, LongTermMemoryRequestContext, MemoryCandidate } from "./contracts.js";
import type { LearningKnowledgeContext, LearningKnowledgeEntry, LearningMemoryDecision } from "./maturation/contracts.js";
import type { ConversationMemoryEvidence } from "./maturation/evidence-contracts.js";
import { candidateKnowledge } from "./maturation/context.js";
import { isCandidateUnexpired } from "./maturation/retention.js";
import { normalizeMemoryText } from "./policies/normalization.js";

/** Translate conversation proposals; all admission and persistence stay in maturation. */
export function prepareConversationDecisions(input: {
  candidates: readonly MemoryCandidate[];
  snapshot: LongTermMemoryRepositorySnapshot;
  context: LongTermMemoryRequestContext;
  now: number;
}) {
  const { snapshot, context, now } = input;
  const evidence = conversationEvidence(input.candidates, context, now);
  const entries = new Map<string, LearningKnowledgeEntry>();
  const decisions: LearningMemoryDecision[] = [];
  let duplicateCount = 0;
  for (const candidate of input.candidates) {
    const key = normalizeMemoryText(candidate.content);
    const assessment = candidate.assessment;
    const existingMemory = snapshot.records.find((record) => normalizeMemoryText(record.content) === key);
    if (existingMemory && !assessment?.target) { duplicateCount += 1; continue; }
    const exactCandidate = snapshot.learningCandidates?.find((record) =>
      isCandidateUnexpired(record, now) && normalizeMemoryText(record.content) === key);
    const target = assessment?.target ?? (exactCandidate ? candidateKnowledge(exactCandidate) : undefined);
    if (target && !target.mutable) { duplicateCount += 1; continue; }
    if (target && entries.has(`${target.kind}:${target.id}`)) { duplicateCount += 1; continue; }
    if (target) entries.set(`${target.kind}:${target.id}`, target);
    decisions.push({
      content: candidate.content, tags: candidate.tags,
      action: target ? "update" : "create", targetKind: target?.kind ?? "candidate",
      targetId: target?.id ?? null, targetVersion: target?.version ?? null,
      mergedCandidateIds: [], observationIds: [],
      score: assessment?.score ?? target?.score ?? 0,
      reason: assessment?.reason ?? target?.reason ?? "Conversation proposal awaiting an assessment of lasting usefulness.",
      certainty: "inferred", reinforced: assessment?.reinforced ?? false,
      reconsiderAt: target?.reconsiderAt ?? null,
    });
  }
  const knowledge: LearningKnowledgeContext = {
    kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent",
    repositoryRevision: snapshot.revision, knowledgeRevision: snapshot.knowledgeRevision ?? snapshot.revision,
    referenceTime: new Date(now).toISOString(), entries: [...entries.values()], omitted: 0,
  };
  return { evidence, decisions, knowledge, duplicateCount };
}

function conversationEvidence(candidates: readonly MemoryCandidate[], context: LongTermMemoryRequestContext, now: number): ConversationMemoryEvidence {
  const assessments = candidates.flatMap((candidate) => candidate.assessment ? [candidate.assessment] : []);
  const evidence = assessments[0]?.evidence ?? {
    sourceSessionId: context.sessionId, sourceRequestId: context.requestId,
    observedAt: new Date(now).toISOString(),
    evidenceDigest: digest([context.sessionId, context.requestId]),
  };
  for (const assessment of assessments) {
    const source = assessment.evidence;
    if (source.sourceSessionId !== context.sessionId || source.sourceRequestId !== context.requestId ||
      source.observedAt !== evidence.observedAt || source.evidenceDigest !== evidence.evidenceDigest)
      throw new Error("learning_conversation_evidence_invalid");
  }
  return evidence;
}

export function conversationMemoryBatchId(context: Pick<LongTermMemoryRequestContext, "sessionId" | "requestId">): string {
  return `conversation:${digest([context.sessionId, context.requestId])}`;
}

function digest(value: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
