import type {
  ConversationSessionClient,
  ConversationSessionState,
} from "./conversation-session-controller.js";

export interface ConversationReadStateControllerOptions {
  state: Pick<
    ConversationSessionState,
    "currentSessionId" | "sessionViewVersion" | "messages"
  >;
  client: Pick<ConversationSessionClient, "markSessionRead">;
  selectedEnvironmentId(): string;
  applyReadState(sessionId: string, readState: unknown): void;
  recordControlEvent(event: Record<string, unknown>): void;
  isConversationVisible?(): boolean;
  scheduleTask?(callback: () => void): unknown;
}

export declare function createConversationReadStateController(
  options: ConversationReadStateControllerOptions,
): {
  markCurrentSessionReadSoon(): void;
};
