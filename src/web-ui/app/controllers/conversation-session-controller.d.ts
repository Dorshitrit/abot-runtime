export type ConversationSessionMessage = Record<string, unknown> & {
  id: string;
  role: string;
  text: string;
  createdAt?: unknown;
  requestId: string;
  streaming?: boolean;
  thinkingText?: string;
  events?: string[];
  attachments?: unknown[];
};

export type ConversationMessage = ConversationSessionMessage & {
  events: string[];
  attachments: unknown[];
};

export type ConversationSession = Record<string, unknown> & {
  id?: string;
};

export type ConversationSessionScope = Readonly<{
  environmentId: string;
  sessionId: string;
}>;

export interface ConversationSessionState {
  currentSessionId: string;
  activeRequestId: string;
  composerSending?: boolean;
  sessionViewVersion: number;
  messages: ConversationSessionMessage[];
  events: Array<Record<string, unknown>>;
  taskProgressByRequest: Map<string, Record<string, unknown>>;
  contextWindowByRequest: Map<string, Record<string, unknown>>;
  submittedToolApprovalIds: Set<string>;
  requestMessages: Map<string, string>;
  lastSeqByRequest: Map<string, number>;
  sessions: ConversationSession[];
}

export interface ConversationSessionClient {
  markSessionRead(options: {
    sessionId: string;
    environmentId: string;
    readThroughMessageId: number | null;
    readThroughRequestId?: string;
  }): Promise<Record<string, unknown>>;
  listSessions(environmentId: string): Promise<Record<string, unknown>>;
  loadSession(
    sessionId: string,
    environmentId: string,
  ): Promise<Record<string, unknown>>;
  fetchRequestEvents(options: {
    requestId: string;
    afterSeq: number;
    environmentId: string;
  }): Promise<unknown[]>;
}

export interface ConversationSessionControllerOptions {
  state: ConversationSessionState;
  dom: {
    sessionTitle: { textContent: string | null };
    sessionsList: { innerHTML: string };
  };
  client: ConversationSessionClient;
  preferences: {
    sessionIdForEnvironment(environmentId: string): string;
    saveSessionIdForEnvironment(environmentId: string, sessionId: string): void;
  };
  sessions: {
    titleOf(session: ConversationSession | undefined): string;
    byId(sessionId: string): ConversationSession | undefined;
    setCurrentTitle(title: string): void;
    applyTitle(sessionId: string, title: unknown): void;
    applyReadState(sessionId: string, readState: unknown): void;
  };
  sessionQueue: {
    peek(scope: ConversationSessionScope): Readonly<{
      waitForRequestId: string;
    }> | null;
    rebindBlocked(scope: ConversationSessionScope, requestId: string): unknown;
  };
  conversationView: { reset(): void };
  selectedEnvironmentId(): string;
  clearPendingAttachments(): void;
  applyConversationChrome(): void;
  applyModelSelection(): void;
  renderSessions(): void;
  renderMessages(): void;
  updateComposerSendState(): void;
  setMessageStatus(message: string): void;
  sendRealtime(message: Record<string, unknown>): unknown;
  handleRealtimeMessage(message: Record<string, unknown>): void;
  recordEvent(event: Record<string, unknown>): void;
  recordControlEvent(event: Record<string, unknown>): void;
  reportQueueFailure(scope: ConversationSessionScope, summary: string): void;
  drainQueuedMessage(
    input: ConversationSessionScope & {
      terminalRequestId: unknown;
    },
  ): void | Promise<void>;
  suspendQueueRecovery(): boolean;
  recoverBlockedQueue(scope: ConversationSessionScope): unknown;
  isCurrentComposerScope(scope: ConversationSessionScope): boolean;
  isConversationVisible?(): boolean;
  onSessionListState?(value: {
    status: "loading" | "ready" | "error";
    sessions: ConversationSession[];
    error?: string;
  }): void;
  scheduleTask?(callback: () => void): unknown;
  createSessionId?(): string;
}

export declare function normalizeConversationMessage(
  raw: unknown,
  fallbackIndex?: number,
): ConversationMessage;

export declare function createConversationSessionController(
  options: ConversationSessionControllerOptions,
): {
  activateRequestForScope(
    scope: { environmentId: string; sessionId: string },
    requestId: string,
  ): void;
  activeAssistantForRequest(requestId: string): ConversationSessionMessage;
  addOrMergeMessage(message: ConversationSessionMessage): void;
  appendLocalUserMessage(input: {
    text: string;
    attachments: unknown[];
    requestId?: string;
  }): void;
  appendRequestError(error: unknown): void;
  applySessionReadState(sessionId: string, readState: unknown): void;
  applySessionTitleUpdate(sessionId: string, title: unknown): void;
  clearCurrentSessionView(): void;
  clearSessionMessagesView(): void;
  ensureSession(): string;
  insertSteerMessage(input: {
    steerId: string;
    requestId: string;
    text: string;
  }): void;
  invalidateEnvironmentLoads(): void;
  loadSessions(): Promise<ConversationSession[]>;
  markCurrentSessionReadSoon(): void;
  normalizeMessage(raw: unknown): ConversationMessage;
  openSession(sessionId: string): Promise<void>;
  requestBelongsToCurrentView(requestId: string): boolean;
  resetLiveRequestView(): void;
  restoreLastSession(): Promise<void>;
  shouldAcceptRealtimeMessage(message: Record<string, unknown>): boolean;
  subscribeSession(sessionId: string): void;
};
