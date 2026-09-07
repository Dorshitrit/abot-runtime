export interface ConversationStatus {
  label: string;
  animate: boolean;
}

export declare function buildConversationStatus(input?: {
  requestId?: string;
  streaming?: boolean;
  connected?: boolean;
  contextWindow?: Record<string, unknown> | null;
  events?: Record<string, unknown>[];
}): ConversationStatus | null;
