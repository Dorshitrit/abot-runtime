import type { SessionComposerQueue, RemoteSessionComposerQueue } from "../lib/session-composer-queue.js";
import type { ComposerAttachmentsClient, ComposerAttachmentsController, ComposerAttachmentsDom, ComposerAttachmentsShell } from "./composer-attachments-controller.js";
import type { ChatRequestController, ComposerChatClient, ComposerChatSession } from "./chat-request-controller.js";
import type { ComposerDraft, ComposerDraftSnapshot, ComposerDrafts, ComposerScope } from "./composer-drafts.js";
import type { ComposerQueueController } from "./composer-queue-controller.js";
import type { ComposerSubmissionLifecycle, ComposerSubmissionSettings } from "./composer-submission-lifecycle.js";
import type { createRealtimeEventController } from "./realtime-event-controller.js";
import type { ComposerSubmissionBlock, ComposerSubmitActions, ComposerSubmitController, ComposerSubmitDom, ComposerSubmitState } from "./composer-submit-controller.js";

export interface ComposerSurfaceDom extends ComposerSubmitDom, ComposerAttachmentsDom {
  composerForm?: HTMLElement;
}
export interface ComposerSurfaceOptions {
  surfaceDom: ComposerSurfaceDom;
  currentDraft(): ComposerDraft;
  ensureDraftSession(): string;
  visible(): boolean;
  supportsImages(): boolean;
  available?(): boolean;
  prepareSend?(payload: ComposerDraftSnapshot): boolean | void | Promise<boolean | void>;
  allowsActiveRequest?: boolean;
}
export interface ComposerSurface {
  attachments: ComposerAttachmentsController;
  submit: ComposerSubmitController;
  render(): void;
  displays(scope: ComposerScope): boolean;
}
export interface ComposerFeatureOptions {
  state: ComposerSubmitState;
  dom: ComposerSurfaceDom;
  shell: ComposerAttachmentsShell;
  client: ComposerChatClient & ComposerAttachmentsClient;
  sessionQueue: SessionComposerQueue | RemoteSessionComposerQueue;
  conversationSession: ComposerChatSession;
  conversationView: { reset(): void };
  getEnvironmentId(): string;
  getDraft(): ComposerDraft;
  ensureSession(): string;
  getSettings(): ComposerSubmissionSettings;
  steer(text: string, options: { scope: ComposerScope & { requestId: string }; pendingAttachmentCount: number }): Promise<void>;
  composerActions: ComposerSubmitActions;
  selectedModelSupportsImageInput(): boolean;
  isComposerAvailable?(): boolean;
  getSubmissionBlock?(): ComposerSubmissionBlock | null;
  onSubmissionBlocked?(block: ComposerSubmissionBlock): void;
  isVisible?(): boolean;
  renderSessions(): void;
  renderMessages(): void;
  applyConversationChrome(): void;
  setMessageStatus(message: string, busy?: boolean): void;
  recordControlEvent: ReturnType<typeof createRealtimeEventController>["recordControlEvent"];
  drafts?: ComposerDrafts;
  onChange?(): void;
  confirmReview?(message: string, options?: { title: string; confirmLabel: string }): boolean | Promise<boolean>;
}
export interface ComposerFeature extends ComposerSurface {
  queue: ComposerQueueController;
  requests: ChatRequestController;
  drafts: ComposerDrafts;
  lifecycle: ComposerSubmissionLifecycle;
  createSurface(options: ComposerSurfaceOptions): ComposerSurface;
  changed(): void;
}
export declare function createComposerFeature(options: ComposerFeatureOptions): ComposerFeature;
