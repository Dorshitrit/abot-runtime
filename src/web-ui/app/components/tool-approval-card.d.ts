import type { ToolActivityEvent } from "../lib/tool-activity-event.js";

export type ToolApprovalEvent = Record<string, unknown> & {
  approvalId?: string;
  eventName?: string;
  name?: string;
  tool?: string;
  summary?: string;
  toolActivity?: ToolActivityEvent;
  recommendedToolPermissionMode?: string;
};

export interface ToolApprovalCardOptions {
  event?: ToolApprovalEvent;
  submitted?: boolean;
  onDecision: (approvalId: string, approved: boolean) => void;
  documentRoot?: Document;
}

export declare function createToolApprovalCard(
  options: ToolApprovalCardOptions,
): HTMLElement;
