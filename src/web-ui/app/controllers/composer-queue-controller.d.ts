import type { RemoteSessionComposerQueue, SessionComposerQueue, SessionComposerQueueItem } from "../lib/session-composer-queue.js";
import type { ComposerAttachment, ComposerDraft, ComposerDraftSnapshot, ComposerDrafts, ComposerScope } from "./composer-drafts.js";
import type { ChatRequestController, ComposerChatAttempt } from "./chat-request-controller.js";
import type { ComposerReviewAuthorization, ComposerSubmissionAttempt, ComposerSubmissionLifecycle, ComposerSubmissionSettings } from "./composer-submission-lifecycle.js";

export type { ComposerScope } from "./composer-drafts.js";
export type ComposerQueueDrainScope = ComposerScope & Readonly<{ terminalRequestId: string; cancelled?: boolean }>;
export interface ComposerNavigationCommit {
  (): void;
  canCommit?(): boolean;
}
export type ComposerNavigationPreparation = false | ComposerNavigationCommit;

export interface ComposerQueueControllerOptions {
  queue: SessionComposerQueue | RemoteSessionComposerQueue;
  drafts: ComposerDrafts;
  lifecycle: ComposerSubmissionLifecycle;
  getDraft(): ComposerDraft;
  requests: Pick<ChatRequestController, "send" | "prepareView" | "activate">;
  getSettings(): ComposerSubmissionSettings;
  isCurrentScope(scope: ComposerScope): boolean;
  reportFailure(scope: ComposerScope, summary: string): void;
  reportRecovery?(scope: ComposerScope, summary: string): void;
  onChange?(): void;
  confirmTakeover?(message: string, options?: { title: string; confirmLabel: string }): boolean | Promise<boolean>;
}

export interface ComposerQueueController {
  currentScope(): ComposerScope;
  drain(scope: ComposerQueueDrainScope): Promise<void>;
  enqueue(attempt: ComposerChatAttempt, waitForRequestId: string): Promise<SessionComposerQueueItem>;
  isCurrentDraining(): boolean;
  isCurrentScope(scope: ComposerScope): boolean;
  prepareManualSend(attempt: ComposerChatAttempt): Promise<void>;
  send(attempt: ComposerChatAttempt): Promise<string>;
  bindAccepted(attempt: ComposerSubmissionAttempt, requestId: string): Promise<void>;
  prepareRestore(attempt: ComposerSubmissionAttempt): Promise<ComposerDraftSnapshot>;
  prepareRecoveryForNavigation(): ComposerNavigationCommit | Promise<ComposerNavigationPreparation>;
  suspendRecoveryForNavigation(canNavigate?: () => boolean): boolean | Promise<boolean>;
  queuedCount(): number;
  recoverForManualSend(scope: ComposerScope): Promise<boolean>;
  hasManualRecovery(scope: ComposerScope): boolean;
  reportFailure(scope: ComposerScope, summary: string): void;
  scopeKey(scope: ComposerScope): string;
  authorizeReview(attempt: ComposerSubmissionAttempt): Promise<ComposerReviewAuthorization>;
  ownsAttachment(attachment: ComposerAttachment): boolean;
}

export declare function createComposerQueueController(options: ComposerQueueControllerOptions): ComposerQueueController;
