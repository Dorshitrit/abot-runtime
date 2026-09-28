import type { LearningReviewCause } from "./contracts.js";

/** Conversation provenance is supplied by the request owner, never by the model. */
export function assertConversationReviewCause(cause: LearningReviewCause | undefined, now: number): void {
  if (cause?.kind !== "conversation_memory_review") return;
  const evidence = cause.evidence;
  if (!evidence || !isIdentifier(evidence.sourceSessionId) || !isIdentifier(evidence.sourceRequestId))
    throw new Error("learning_conversation_evidence_invalid");
  if (!/^[a-f0-9]{64}$/u.test(evidence.evidenceDigest)) throw new Error("learning_conversation_evidence_invalid");
  const timestamp = Date.parse(evidence.observedAt);
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp >= 86_400_000)
    throw new Error("learning_conversation_evidence_expired");
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}
