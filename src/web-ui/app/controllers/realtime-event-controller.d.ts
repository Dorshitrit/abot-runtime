import type { ConversationSessionMessage } from "./conversation-session-controller.js";

export type RealtimeEventRecord = Record<string, unknown>;

export interface RealtimeEventControllerState {
  activeRequestId: string;
  currentSessionId: string;
  contextWindowByRequest: Map<string, Record<string, unknown>>;
  taskProgressByRequest: Map<string, Record<string, unknown>>;
  lastSeqByRequest: Map<string, number>;
  events: RealtimeEventRecord[];
}

export interface RealtimeEventControllerOptions {
  state: RealtimeEventControllerState;
  shell: {
    showToast(message: string, tone?: string): void;
  };
  selectedEnvironmentId(): string;
  handleSteerAcknowledgement(message: RealtimeEventRecord): boolean;
  shouldAcceptMessage(message: RealtimeEventRecord): boolean;
  applySessionReadState(sessionId: unknown, readState: unknown): void;
  activeAssistantForRequest(requestId: string): ConversationSessionMessage;
  addOrMergeMessage(message: ConversationSessionMessage): void;
  normalizeChatMessage(
    message: RealtimeEventRecord,
  ): ConversationSessionMessage;
  renderMessages(): void;
  scheduleMessageRender(): void;
  scheduleThinkingRender(): void;
  cancelScheduledMessageRender(): void;
  cancelScheduledThinkingRender(): void;
  forgetThinkingDisclosure(messageId: string): void;
  markCurrentSessionReadSoon(): void;
  applySessionTitleUpdate(sessionId: unknown, title: unknown): void;
  setMessageActivityStatus(message: string): void;
  updateComposerSendState(): void;
  drainQueuedComposerMessage(input: {
    environmentId: string;
    sessionId: string;
    terminalRequestId: string;
  }): void | Promise<void>;
  loadSessions(): void | Promise<unknown>;
}

export declare function normalizeRealtimeMessage(
  rawMessage: unknown,
): RealtimeEventRecord;
export declare function taskStatusClass(status: unknown): string;
export declare function createRealtimeEventController(
  options: RealtimeEventControllerOptions,
): {
  handle(rawMessage: unknown): void;
  recordControlEvent(event: RealtimeEventRecord): void;
  recordEvent(message: RealtimeEventRecord): void;
  trackSeq(message: RealtimeEventRecord): void;
};
