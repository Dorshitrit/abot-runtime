export declare function createComposerStopController(options: {
  state: Record<string, any>;
  selectedEnvironmentId(): string;
  stopRequest(
    scope: Record<string, unknown>,
  ): Promise<{ accepted: boolean; reason?: string }>;
  updateSendState(): void;
  setMessageStatus(message: string, pending?: boolean): void;
}): { stop(): Promise<void>; isStopping(): boolean };
