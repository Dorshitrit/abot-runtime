import type { ChatMessage } from "../../model-gateway/types.js";
import type { UserInteractionSnapshot } from "./contracts.js";

/** Only root decision and presentation consumers opt into this passive receipt. */
export function projectUserInteractionContext(
  snapshot: UserInteractionSnapshot | undefined,
): ChatMessage | undefined {
  if (!snapshot) return undefined;
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: "runtime_user_interaction_receipts_v1",
      authority: "assistant_communication",
      purpose: "Recent updates already published during this request; avoid repeating them.",
      applicability: "Current request decision and response presentation only.",
      nonAuthority: "Not user intent, new work, tool evidence, proof of completion, or proof the user read the messages.",
      publishedCount: snapshot.publishedCount,
      omittedCount: snapshot.publishedCount - snapshot.recent.length,
      omission: "Older published messages are omitted, not retracted. Full messages remain request events.",
      entries: snapshot.recent.map((entry) => ({
        interactionId: entry.interactionId,
        sequence: entry.sequence,
        origin: entry.origin,
        text: entry.payload.text,
      })),
    }),
  });
}
