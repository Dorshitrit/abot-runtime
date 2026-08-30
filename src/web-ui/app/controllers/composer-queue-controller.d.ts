import type {
  SessionComposerAttachmentRef,
  SessionComposerModelPreference,
  SessionComposerQueue,
} from "../lib/session-composer-queue.js";

export type ComposerScope = Readonly<{
  environmentId: string;
  sessionId: string;
}>;

export type ComposerQueueDrainScope = ComposerScope &
  Readonly<{ terminalRequestId: string }>;

export interface ComposerQueueRecovery {
  scope: ComposerScope;
  releaseToken: string;
}

export interface ComposerQueueMessage {
  id?: string;
  role?: string;
  text?: string;
  createdAt?: unknown;
  requestId?: string;
  streaming?: boolean;
}

export interface ComposerQueueState {
  activeRequestId: string;
  agentMode: string;
  currentSessionId: string;
  pendingAttachments: SessionComposerAttachmentRef[];
  composerQueueDrainingScopes: Set<string>;
  composerQueueRecoveredReleaseTokens: Set<string>;
  activeComposerQueueRecovery: ComposerQueueRecovery | null;
  messages: ComposerQueueMessage[];
}

export interface ComposerQueueDom {
  composerInput: {
    value: string;
  };
}

export interface ComposerQueueAttachments {
  clear(options?: { cleanup?: boolean }): void;
  invalidateCompletions(): void;
  render(): void;
}

export interface ComposerQueuePostChatRequest {
  text: string;
  attachments: SessionComposerAttachmentRef[];
  environmentId: string;
  sessionId: string;
  agentMode: string;
  toolPermissionMode: string;
  modelPreference: SessionComposerModelPreference | null;
}

export interface ComposerQueueControlEvent {
  type: "control";
  name: string;
  tone: "failed";
  summary: string;
}

export interface ComposerQueueControllerOptions {
  state: ComposerQueueState;
  dom: ComposerQueueDom;
  queue: SessionComposerQueue;
  selectedEnvironmentId: () => string;
  getToolPermissionMode: () => string;
  getModelPreference: () => SessionComposerModelPreference | null;
  rememberModelSelection: () => void;
  attachments: ComposerQueueAttachments;
  updateSendState: () => void;
  postChatMessage: (request: ComposerQueuePostChatRequest) => Promise<string>;
  appendLocalUserMessage: (message: {
    text: string;
    attachments: SessionComposerAttachmentRef[];
    requestId: string;
  }) => void;
  activateRequestForScope: (scope: ComposerScope, requestId: string) => void;
  renderMessages: () => void;
  setMessageStatus: (message: string, busy?: boolean) => void;
  recordControlEvent: (event: ComposerQueueControlEvent) => void;
  resizeComposer: () => void;
}

export interface ComposerQueueController {
  clearRecovery(scope: ComposerScope): void;
  currentScope(): ComposerScope;
  drain(scope: ComposerQueueDrainScope): Promise<void>;
  enqueue(text: string): Promise<void>;
  isCurrentDraining(): boolean;
  isCurrentScope(scope: ComposerScope): boolean;
  queuedCount(): number;
  recoverForManualSend(scope: ComposerScope): boolean;
  reportFailure(scope: ComposerScope, summary: string): void;
  restoreText(text: string, scope: ComposerScope): void;
  scopeKey(scope: ComposerScope): string;
  suspendRecoveryForNavigation(): boolean;
}

export declare function createComposerQueueController(
  options: ComposerQueueControllerOptions,
): ComposerQueueController;
