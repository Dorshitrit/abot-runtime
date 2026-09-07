import type { ToolActivityField } from "./tool-activity-model.js";

export interface ToolActivityEvent {
  name: string;
  tool: string;
  executionId: string;
  executorRole: string;
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
