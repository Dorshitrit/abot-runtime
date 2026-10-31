import type { ConversationToolAction } from "./tool-activity-model.js";
import type { MemoryActivity } from "./memory-activity-model.js";
import type { BasketActivity } from "./basket-activity-model.js";
import type { RoleDelegation } from "./role-delegation-event.js";
import type { RoleReturn } from "./role-return-event.js";

type EntryIdentity = { id: string; role: string; callId?: string };
export type ConversationWorkTimelineEntry = EntryIdentity & (
  | { kind: "tool"; action: ConversationToolAction }
  | { kind: "message"; source: "interaction" | "acknowledgement" | "intent"; text: string;
      origin?: { callId: string; activationCount: number; steeringVersion: number } }
  | { kind: "event"; event: Record<string, unknown> }
  | { kind: "memory"; activities: MemoryActivity[] }
  | { kind: "basket"; activities: BasketActivity[] }
  | { kind: "skill"; activities: { summary: string; tone: string }[] }
  | { kind: "delegation"; delegation: RoleDelegation }
  | { kind: "return"; receipt: RoleReturn }
);
export declare function isAcknowledgementPresentationEvent(event: unknown): boolean;
export declare function buildConversationWorkTimeline(input?: {
  requestId?: string;
  events?: Record<string, unknown>[];
  updates?: Record<string, unknown>[];
  streaming?: boolean;
}): ConversationWorkTimelineEntry[];
