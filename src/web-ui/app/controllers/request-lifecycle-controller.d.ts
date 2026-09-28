export declare function createRequestLifecycleController(options: {
  state: Record<string, any>;
  addOrMergeMessage(message: any): void;
  normalizeChatMessage(message: any): any;
  activeAssistantForRequest(requestId: string): { streaming: boolean };
  updateComposerSendState(): void;
  renderMessages(): void;
  setMessageActivityStatus(message: string): void;
  markCurrentSessionReadSoon(): void;
  cancelScheduledMessageRender(): void;
  cancelScheduledThinkingRender(): void;
}): { handle(message: Record<string, unknown>): boolean };
