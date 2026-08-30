import type { ComposerScope } from "./composer-queue-controller.js";

export interface ComposerSubmissionBlock {
  code: string;
  message: string;
}

export interface ComposerSubmitState {
  activeRequestId: string;
  pendingAttachments: readonly unknown[];
  composerSending: boolean;
  currentSessionId: string;
}

export interface ComposerSubmitDom {
  composerInput: {
    value: string;
    scrollHeight: number;
    style: { height: string };
    focus(): void;
  };
}

export interface ComposerSubmitActions {
  primaryAction(): string;
  render(options: {
    activeRequestId: string;
    attachmentCount: number;
    busy: boolean;
    disabled: boolean;
    queuedCount: number;
  }): void;
}

export interface ComposerSubmitAttachments {
  activeUploadCount(): number;
}

export interface ComposerSubmitQueue {
  enqueue(text: string): Promise<void>;
  isCurrentDraining(): boolean;
  queuedCount(): number;
  restoreText(text: string, scope: ComposerScope): void;
}

export interface ComposerSubmitChatRequests {
  sendMessage(text: string): Promise<void>;
}

export interface ComposerSubmitConversationSession {
  appendRequestError(error: unknown): void;
}

export interface ComposerSubmitControllerOptions {
  state: ComposerSubmitState;
  dom: ComposerSubmitDom;
  composerActions: ComposerSubmitActions;
  attachments: ComposerSubmitAttachments;
  queue: ComposerSubmitQueue;
  steer: (text: string) => Promise<void>;
  chatRequests: ComposerSubmitChatRequests;
  conversationSession: ComposerSubmitConversationSession;
  selectedEnvironmentId: () => string;
  setMessageStatus: (message: string, busy?: boolean) => void;
  getSubmissionBlock?: () => ComposerSubmissionBlock | null;
  onSubmissionBlocked?: (block: ComposerSubmissionBlock) => void;
}

export interface ComposerSubmitController {
  dispatch(requestedAction?: string): void;
  resize(): void;
  updateSendState(): void;
}

export declare function createComposerSubmitController(
  options: ComposerSubmitControllerOptions,
): ComposerSubmitController;
