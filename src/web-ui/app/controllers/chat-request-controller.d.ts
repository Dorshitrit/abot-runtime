import type { createRuntimeWebClient } from "../services/runtime-web-client.js";
import type { createConversationSessionController } from "./conversation-session-controller.js";
import type { ComposerScope } from "./composer-drafts.js";
import type { ComposerSubmissionAttempt, ComposerSubmissionSettings } from "./composer-submission-lifecycle.js";

type RuntimeWebClient = ReturnType<typeof createRuntimeWebClient>;
export type ComposerChatClient = Pick<RuntimeWebClient, "postChatMessage" | "stopChatRequest">;
export type ComposerChatSession = Pick<ReturnType<typeof createConversationSessionController>, "appendLocalUserMessage" | "activateRequestForScope">;
export type ComposerChatAttempt = ComposerSubmissionAttempt<ComposerSubmissionSettings>;

export interface ChatRequestControllerOptions {
  client: ComposerChatClient;
  conversationView: { reset(): void };
  conversationSession: ComposerChatSession;
  isCurrentComposerScope(scope: ComposerScope): boolean;
  applyConversationChrome(): void;
  renderSessions(): void;
}

export interface ChatRequestController {
  prepareView(attempt: ComposerSubmissionAttempt): void;
  postChatMessage: RuntimeWebClient["postChatMessage"];
  send(attempt: ComposerChatAttempt): Promise<string>;
  activate(attempt: ComposerSubmissionAttempt, requestId: string): void;
  stopRequest: RuntimeWebClient["stopChatRequest"];
}

export declare function createChatRequestController(options: ChatRequestControllerOptions): ChatRequestController;
