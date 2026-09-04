export type ConversationRole = "supervisor" | "planner" | "worker" | "reviewer";

export interface ConversationRoleCard {
  id: string;
  role: ConversationRole;
  title: string;
  responsibility: string;
  phaseLabel: string;
  summary: string;
  facts: string[];
  active: boolean;
  tone: "active" | "failed" | "recorded";
}

export function buildConversationRoleCards(input?: {
  requestId?: unknown;
  events?: unknown[];
  streaming?: boolean;
}): ConversationRoleCard[];
