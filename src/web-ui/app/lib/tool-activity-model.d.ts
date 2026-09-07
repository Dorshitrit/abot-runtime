export interface ToolActivityField {
  label: string;
  value: string;
}

export interface ConversationToolAction {
  id: string;
  tool: string;
  executorRole?: string;
  roleCallId?: string;
  title: string;
  target: string;
  status:
    | "preparing"
    | "running"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "empty"
    | "unchanged"
    | "incomplete";
  statusLabel: string;
  intent: string;
  sent: ToolActivityField[];
  received: ToolActivityField[];
  preview: string;
  previewTruncated: boolean;
  executed: boolean;
  partial: boolean;
  legacy: boolean;
  count: number;
}

export declare function buildConversationToolActions(input: {
  requestId: string;
  events?: Record<string, unknown>[];
  streaming?: boolean;
}): ConversationToolAction[];
export declare function summarizeConversationTools(
  actions: ConversationToolAction[],
): string;
