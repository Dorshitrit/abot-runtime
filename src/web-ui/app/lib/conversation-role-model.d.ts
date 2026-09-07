import type { ConversationToolAction } from "./tool-activity-model.js";

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
  active: boolean;
  tone: "active" | "failed" | "recorded";
}

export function buildConversationRoleCards(input?: {
  requestId?: unknown;
  events?: unknown[];
  streaming?: boolean;
}): ConversationRoleCard[];
