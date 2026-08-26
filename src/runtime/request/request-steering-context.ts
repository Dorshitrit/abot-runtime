import type { ChatMessage } from "../../model-gateway/types.js";
import {
  REQUEST_STEERING_MESSAGE_KIND,
  type RequestSteeringSnapshot,
} from "./request-steering.js";

export function appendRequestSteeringContext(
  messages: readonly ChatMessage[],
  snapshot: RequestSteeringSnapshot,
): ChatMessage[] {
  if (snapshot.updates.length === 0) {
    return [...messages];
  }
  return [
    ...messages,
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: REQUEST_STEERING_MESSAGE_KIND,
        authority: "user",
        version: snapshot.version,
        guidance:
          "These are later user messages for the same active request. Consider them in order alongside the original request and current state. Decide their effect; they may refine, redirect, add to, or ask to stop work. Do not assume cancellation or completion merely because an update exists.",
        updates: snapshot.updates.map(({ sequence, text }) => ({
          sequence,
          text,
        })),
      }),
    }),
  ];
}
