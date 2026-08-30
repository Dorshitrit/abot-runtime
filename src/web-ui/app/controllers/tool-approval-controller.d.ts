import type {
  ToolApprovalCardOptions,
  ToolApprovalEvent,
} from "../components/tool-approval-card.js";

export interface ToolApprovalControllerState {
  connected: boolean;
  events: ToolApprovalEvent[];
  submittedToolApprovalIds: Set<string>;
}

export interface ToolApprovalControllerOptions {
  state: ToolApprovalControllerState;
  selectedEnvironmentId(): string;
  sendRealtime(message: Record<string, unknown>): unknown;
  renderMessages(): void;
  recordControlEvent(event: Record<string, unknown>): void;
  createCard(options: ToolApprovalCardOptions): HTMLElement;
}

export declare function createToolApprovalController(
  options: ToolApprovalControllerOptions,
): {
  createCard(event: ToolApprovalEvent | undefined): HTMLElement;
  isPending(event: ToolApprovalEvent | undefined): boolean;
  pendingEvent(): ToolApprovalEvent | undefined;
  submit(approvalId: string, approved: boolean): boolean;
};
