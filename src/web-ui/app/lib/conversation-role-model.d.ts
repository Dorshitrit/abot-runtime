import type { BasketActivity } from "./basket-activity-model.js";
import type { ConversationToolAction } from "./tool-activity-model.js";
import type { RoleDelegation } from "./role-delegation-event.js";
import type { RoleReturn } from "./role-return-event.js";

export type ConversationRole =
  | "supervisor"
  | "planner"
  | "worker"
  | "researcher"
  | "reviewer"
  | "unknown";

export interface ConversationRoleCard {
  id: string;
  role: ConversationRole;
  title: string;
  responsibility: string;
  phaseLabel: string;
  summary: string;
  facts: string[];
  toolActions?: ConversationToolAction[];
  skillActivities?: { summary: string; tone: string }[];
  basketActivities?: BasketActivity[];
  delegations?: RoleDelegation[];
  returns?: RoleReturn[];
  active: boolean;
  tone: "active" | "failed" | "recorded";
}

export function buildConversationRoleCards(input?: {
  requestId?: unknown;
  events?: unknown[];
  streaming?: boolean;
}): ConversationRoleCard[];
