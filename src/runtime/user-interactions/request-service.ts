import type { EventSink } from "../ports.js";
import {
  USER_INTERACTION_EVENT_NAME,
  USER_INTERACTION_RECEIPT_LIMIT,
  type PublishedUserInteraction,
  type RequestUserInteractions,
  type UserInteractionBinding,
  type UserInteractionSnapshot,
} from "./contracts.js";
import { projectUserInteractionContext } from "./context.js";
import {
  hasUserInteractionBinding,
  isUserInteractionMessageText,
  restoreUserInteractionSnapshot,
  userInteractionId,
} from "./snapshot.js";

export function createRequestUserInteractions(params: {
  requestId: string;
  events: Pick<EventSink, "event">;
  restored?: unknown;
}): RequestUserInteractions {
  const restored = restoreUserInteractionSnapshot(params.restored, params.requestId);
  let publishedCount = restored?.publishedCount ?? 0;
  let recent = [...(restored?.recent ?? [])];

  function snapshot(): UserInteractionSnapshot | undefined {
    if (publishedCount === 0) return undefined;
    return Object.freeze({ publishedCount, recent: Object.freeze([...recent]) });
  }

  return Object.freeze({
    snapshot,
    projectContext: () => projectUserInteractionContext(snapshot()),
    publish(proposal, binding) {
      if (proposal.kind !== "message" || !isUserInteractionMessageText(proposal.text))
        throw new Error("user_interaction_proposal_invalid");
      if (!hasUserInteractionBinding(binding))
        throw new Error("user_interaction_binding_invalid");
      const existing = recent.find((entry) => hasSamePublicationBinding(entry.origin, binding));
      if (existing) {
        if (existing.payload.text !== proposal.text)
          throw new Error("user_interaction_publication_conflict");
        return;
      }
      const sequence = publishedCount + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("user_interaction_sequence_exhausted");
      const interaction: PublishedUserInteraction = Object.freeze({
        version: 1,
        interactionId: userInteractionId(params.requestId, sequence),
        requestId: params.requestId,
        sequence,
        createdAt: new Date().toISOString(),
        kind: "message",
        payload: Object.freeze({ text: proposal.text }),
        origin: Object.freeze({ ...binding }),
      });
      // Keep the EventSink's existing persistence/delivery failure boundary.
      // A receipt means accepted for publication, not acknowledged by a browser.
      params.events.event(USER_INTERACTION_EVENT_NAME, { interaction });
      publishedCount = sequence;
      recent = [...recent, interaction].slice(-USER_INTERACTION_RECEIPT_LIMIT);
    },
  });
}

function hasSamePublicationBinding(
  left: UserInteractionBinding,
  right: UserInteractionBinding,
): boolean {
  if (left.callId !== right.callId) return false;
  if (left.activationCount !== right.activationCount) return false;
  return left.steeringVersion === right.steeringVersion;
}
