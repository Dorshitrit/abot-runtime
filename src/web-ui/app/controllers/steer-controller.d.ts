export declare function createSteerController(options: {
  sendRealtime: (payload: Record<string, unknown>) => boolean;
  getScope: () => {
    requestId: string;
    environmentId: string;
    sessionId: string;
  };
  getPendingAttachmentCount: () => number;
  onAccepted: (message: {
    steerId: string;
    requestId: string;
    text: string;
  }) => void;
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): {
  handleAcknowledgement(message: Record<string, unknown>): boolean;
  rejectAll(reason: string): void;
  steer(text: string): Promise<void>;
};
