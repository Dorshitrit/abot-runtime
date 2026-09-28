import { createHash } from "node:crypto";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import type { LearningKnowledgeEntry } from "../maturation/contracts.js";
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
  const learning = request.longTermMemory?.learning;
  if (!request.longTermMemory?.enabled || !learning) return undefined;
  try {
    const context = await learning.prepare({
      query: buildMemoryRetrievalQuery(request.prompt, steering),
      abortSignal: request.abortSignal,
      debugRequestId: request.requestId,
    });
    const evidence = Object.freeze({
      sourceSessionId: request.sessionId,
      sourceRequestId: request.requestId,
      observedAt: context.referenceTime,
      evidenceDigest: createHash("sha256").update(JSON.stringify([
        request.prompt, ...steering.updates.map(({ text }) => text),
      ])).digest("hex"),
    });
    const entries = structuredClone(context.entries);
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
  } catch (error: unknown) {
    request.abortSignal.throwIfAborted();
    traceDebug("runtime.memory", "authoring_context_unavailable", {
      requestId: request.requestId, errorType: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}
