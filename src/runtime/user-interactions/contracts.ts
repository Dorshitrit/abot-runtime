import type { ChatMessage } from "../../model-gateway/types.js";

export const USER_INTERACTION_EVENT_NAME = "user.interaction";
export const USER_INTERACTION_TEXT_MAX_LENGTH = 1_200;
export const USER_INTERACTION_RECEIPT_LIMIT = 8;

export type UserInteractionKind = "message";

/** Model-authored presentation only; identity and authority belong to Runtime. */
export type UserInteractionProposal = Readonly<{
  kind: "message";
  text: string;
}>;

export type UserInteractionBinding = Readonly<{
  callId: string;
  activationCount: number;
  steeringVersion: number;
}>;

export type PublishedUserInteraction = Readonly<{
  version: 1;
  interactionId: string;
  requestId: string;
  sequence: number;
  createdAt: string;
  kind: "message";
  payload: Readonly<{ text: string }>;
  origin: UserInteractionBinding;
}>;

/** Presentation receipts only; never work state, tool evidence or user intent. */
export type UserInteractionSnapshot = Readonly<{
  publishedCount: number;
  recent: readonly PublishedUserInteraction[];
}>;

export type RequestUserInteractions = Readonly<{
  publish(proposal: UserInteractionProposal, binding: UserInteractionBinding): void;
  snapshot(): UserInteractionSnapshot | undefined;
  projectContext(): ChatMessage | undefined;
}>;
