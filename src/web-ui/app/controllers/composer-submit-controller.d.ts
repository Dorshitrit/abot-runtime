import type { ComposerDraft } from "./composer-drafts.js";
import type { ComposerInputSurface } from "./composer-draft-view.js";
import type { ComposerAttachmentsController } from "./composer-attachments-controller.js";
import type { ComposerQueueController } from "./composer-queue-controller.js";
import type { ChatRequestController } from "./chat-request-controller.js";
import type { ComposerSubmissionAction, ComposerSubmissionLifecycle, ComposerSubmissionResult } from "./composer-submission-lifecycle.js";
import type { ConversationSessionState } from "./conversation-session-controller.js";

export interface ComposerSubmissionBlock { code: string; message: string }
export type ComposerSubmitState = Pick<ConversationSessionState, "activeRequestId" | "currentSessionId" | "requestLifecycles">;
export interface ComposerSubmitDom { composerInput: ComposerInputSurface }

export interface ComposerSubmitActions {
  primaryAction(): ComposerSubmissionAction;
  render(options: {
    activeRequestId: string;
    waitingRequestId?: string;
    stopping: boolean;
    onStop(): void;
    attachmentCount: number;
    busy: boolean;
    disabled: boolean;
    queuedCount: number;
  }): void;
}

export type ComposerDispatchResult = ComposerSubmissionResult | { status: "blocked"; error: unknown };
export interface ComposerSubmitControllerOptions {
  state: ComposerSubmitState;
  dom: ComposerSubmitDom;
  composerActions: ComposerSubmitActions;
  getDraft(): ComposerDraft;
  attachments: Pick<ComposerAttachmentsController, "activeUploadCount">;
  queue: Pick<ComposerQueueController, "isCurrentDraining" | "queuedCount">;
  lifecycle: Pick<ComposerSubmissionLifecycle, "hasPendingScope">;
  submit(action: ComposerSubmissionAction): Promise<ComposerSubmissionResult>;
  stopRequest: ChatRequestController["stopRequest"];
  selectedEnvironmentId(): string;
  setMessageStatus(message: string, busy?: boolean): void;
  getSubmissionBlock?(): ComposerSubmissionBlock | null;
  onSubmissionBlocked?(block: ComposerSubmissionBlock): void;
  isComposerVisible?(): boolean;
  allowsActiveRequest?: boolean;
}

export interface ComposerSubmitController {
  stop(): false | Promise<void>;
  dispatch(requestedAction?: ComposerSubmissionAction): undefined | Promise<ComposerDispatchResult>;
  resize(): void;
  updateSendState(): void;
}
export declare function createComposerSubmitController(options: ComposerSubmitControllerOptions): ComposerSubmitController;
