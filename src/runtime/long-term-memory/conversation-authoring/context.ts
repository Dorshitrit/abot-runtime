import { createHash } from "node:crypto";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import type { LearningKnowledgeEntry, LearningKnowledgeContext } from "../maturation/contracts.js";
import type { ConversationMemoryEvidence } from "../maturation/evidence-contracts.js";
import { buildMemoryRetrievalQuery } from "../response-context.js";
import { traceDebug } from "../../observability/debug-logger.js";

export type ConversationMemoryAuthoringContext = Readonly<{
  evidence: ConversationMemoryEvidence;
  targets: ReadonlyMap<string, LearningKnowledgeEntry>;
  userMessages: readonly string[];
  message: ChatMessage;
}>;

export function canAuthorConversationMemory(
  request: Pick<RequestExecutionScope, "longTermMemory">,
  context: ConversationMemoryAuthoringContext | undefined,
): boolean {
  if (!request.longTermMemory?.enabled) return false;
  if (!request.longTermMemory.learning) return true;
  return context !== undefined;
}

/** Request-local authoring reference; never part of ordinary recall or routing. */
export async function prepareConversationMemoryAuthoring(
  request: Pick<RequestExecutionScope, "longTermMemory" | "requestId" | "sessionId" | "prompt" | "abortSignal">,
  steering: RequestSteeringSnapshot,
): Promise<ConversationMemoryAuthoringContext | undefined> {
  const context = await prepareConversationMemoryKnowledge(request, steering);
  return context ? buildConversationMemoryAuthoringContext(request, steering, context) : undefined;
}

export async function prepareConversationMemoryKnowledge(
  request: Pick<RequestExecutionScope, "longTermMemory" | "requestId" | "sessionId" | "prompt" | "abortSignal">,
  steering: RequestSteeringSnapshot,
): Promise<LearningKnowledgeContext | undefined> {
  const learning = request.longTermMemory?.learning;
  if (!request.longTermMemory?.enabled || !learning) return undefined;
  try {
    const context = await learning.prepare({
      query: buildMemoryRetrievalQuery(request.prompt, steering),
      abortSignal: request.abortSignal,
      debugRequestId: request.requestId,
    });
    return context;
  } catch (error: unknown) {
    request.abortSignal.throwIfAborted();
    traceDebug("runtime.memory", "authoring_context_unavailable", {
      requestId: request.requestId, errorType: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

/** Shared deterministic binding for decision and response authoring. No retrieval. */
export function buildConversationMemoryAuthoringContext(
  request: Pick<RequestExecutionScope, "requestId" | "sessionId" | "prompt">,
  steering: RequestSteeringSnapshot,
  context: Pick<LearningKnowledgeContext, "entries" | "omitted" | "referenceTime">,
): ConversationMemoryAuthoringContext {
  const evidence = Object.freeze({
    sourceSessionId: request.sessionId,
    sourceRequestId: request.requestId,
    observedAt: context.referenceTime,
    evidenceDigest: createHash("sha256").update(JSON.stringify([
      request.prompt, ...steering.updates.map(({ text }) => text),
    ])).digest("hex"),
  });
  // Project only contract fields, including when entries come from a saved checkpoint.
  const entries = context.entries.map(projectConversationMemoryKnowledgeEntry);
  const targets = new Map(entries.map((entry, index) => [`k${index + 1}`, Object.freeze(entry)]));
  return Object.freeze({
    evidence, targets,
    userMessages: Object.freeze([request.prompt, ...steering.updates.map(({ text }) => text)]),
    message: Object.freeze({ role: "system" as const, content: JSON.stringify({
      kind: "conversation_memory_authoring_reference_v1",
      authority: "passive_memory_reference",
      purpose: "assess_lasting_user_knowledge_and_resolve_optional_update_targets",
      applicability: "memoryCandidates_only",
      presenceEffect: "not_user_intent_fresh_evidence_or_action_authority",
      targetPolicy: "null_creates_candidate_only_use_supplied_mutable_refs_for_updates",
      omitted: context.omitted,
      omissionMeaning: "unlisted_knowledge_is_unknown_and_cannot_be_targeted",
      entries: [...targets].map(([ref, { id: _id, version: _version, ...entry }]) => ({ ref, ...entry })),
    }) }),
  });
}

/** The same contract projection must precede ledger cloning and durable approval capture. */
export function projectConversationMemoryKnowledge(
  context: LearningKnowledgeContext,
): LearningKnowledgeContext {
  return {
    kind: context.kind, authority: context.authority, presenceEffect: context.presenceEffect,
    repositoryRevision: context.repositoryRevision, knowledgeRevision: context.knowledgeRevision,
    referenceTime: context.referenceTime, omitted: context.omitted,
    entries: context.entries.map(projectConversationMemoryKnowledgeEntry),
  };
}

function projectConversationMemoryKnowledgeEntry(entry: LearningKnowledgeEntry): LearningKnowledgeEntry {
  return {
    kind: entry.kind, id: entry.id, version: entry.version,
    content: entry.content, tags: [...entry.tags], mutable: entry.mutable,
    score: entry.score, reason: entry.reason, certainty: entry.certainty,
    lastReinforcedAt: entry.lastReinforcedAt, reconsiderAt: entry.reconsiderAt,
  };
}
