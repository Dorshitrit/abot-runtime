export declare function decodeRealtimeFrame(data: unknown): Promise<string>;

export declare function createRealtimeTransport(options: {
  getConfig: () => Record<string, unknown> | null;
  onMessage: (message: Record<string, unknown>) => void;
  onOpen: () => void;
  onClose: () => void;
  onError: () => void;
  onParseError: (error: unknown, preview: string) => void;
  reconnectDelayMs?: number;
  WebSocketImpl?: typeof WebSocket;
  location?: Pick<Location, "protocol" | "host">;
  scheduleReconnect?: typeof setTimeout;
}): {
  connect(): void;
  send(payload: Record<string, unknown>): boolean;
};
