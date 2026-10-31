import type { ConversationFileReference } from "./conversation-file-reference.js";
import type { ToolActivityField } from "./tool-activity-model.js";

export interface ToolActivityEvent {
  fileReference?: ConversationFileReference;
  skillRead?: true;
  name: string;
  tool: string;
  activityTitle?: string;
  executionId: string;
  executorRole: string;
  presentationRole?: "execution_agent" | "auditor";
  roleCallId: string;
  payloadStage?: number;
  payloadStageCount?: number;
  beforeExternalExecution: boolean;
  intent: string;
  target: string;
  sent: ToolActivityField[];
  received: ToolActivityField[];
  preview: string;
  previewTruncated: boolean;
  partial: boolean;
  outcome: "unchanged" | "empty" | "completed";
  ok: boolean | null;
  error: string;
}

export declare function projectToolActivityEvent(
  message: Record<string, unknown>,
): ToolActivityEvent | null;
