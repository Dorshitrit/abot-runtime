import type { ConversationSessionMessage } from "../controllers/conversation-session-controller.js";

export type UserInteractionMessage = ConversationSessionMessage & {
  kind: "user_interaction";
  interactionId: string;
  interactionSequence: number;
  interactionGeneration: string;
  interactionOrigin: { callId: string; activationCount: number; steeringVersion: number };
  eventSequence?: number;
  seqNo?: number;
};

export declare function isUserInteractionEvent(event: unknown): boolean;
export declare function isUserInteractionMessage(message: unknown): boolean;
export declare function projectUserInteractionEvent(
  event: Record<string, unknown>,
): UserInteractionMessage | null;
