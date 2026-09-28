import type { LearningChangedEvent } from "../passive-learning/contracts.js";

/** Only committed proposal identity crosses invalidation transports. */
export function projectLearningChangedEvent(
  value: unknown,
): LearningChangedEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (event.type !== "proposal_delivered") return undefined;
  if (!isLearningEventId(event.proposalId)) return undefined;
  if (!isLearningEventId(event.sessionId)) return undefined;
  return {
    type: "proposal_delivered",
    proposalId: event.proposalId,
    sessionId: event.sessionId,
  };
}

export function isLearningEventId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.trim() || value.length > 256) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
}
