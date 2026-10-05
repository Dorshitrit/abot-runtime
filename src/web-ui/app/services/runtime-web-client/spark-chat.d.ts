export interface SparkChatReadState {
  unreadCount: number;
  unreadMessageIds: Array<string | number>;
  readRevision: number;
  readGeneration: string;
  hasUnread: boolean;
}
export interface SparkChatSnapshot {
  ok: boolean;
  sessionId: string;
  toolPermissionMode: "ask" | "full_access" | "full_plus";
  modelProfileId: string | null;
  snapshot: { messages: Array<Record<string, unknown>>; requests?: Array<Record<string, unknown>> };
  readState: SparkChatReadState;
}
export interface SparkChatRequests {
  supportsSparkChat(): boolean;
  loadSparkChat(environmentId?: string): Promise<SparkChatSnapshot>;
  configureSparkChat(input: { toolPermissionMode: "ask" | "full_access" | "full_plus" }, environmentId?: string): Promise<SparkChatSnapshot>;
  createSparkHandoffSession(input: { message: { id: string | number; createdAt: number; requestId: string | null } }, environmentId?: string): Promise<{ ok: boolean; sessionId: string }>;
  markSparkMessagesRead(input: { visibleMessageIds: Array<string | number>; visibleMessages: Array<{ id: string | number; createdAt: number; requestId: string | null }>; readGeneration: string }, environmentId?: string): Promise<{ ok: boolean; readState: SparkChatReadState }>;
}
