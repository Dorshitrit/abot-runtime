import type { ConversationFilePreview } from "../../lib/conversation-file-preview.js";
export type { ConversationFilePreview } from "../../lib/conversation-file-preview.js";
export interface ConversationFileRequest {
  environmentId: string;
  sessionId: string;
  requestId: string;
  executionId: string;
  signal?: AbortSignal;
}
export interface ConversationFileClient {
  supportsConversationFiles(): boolean;
  loadConversationFile(
    input: ConversationFileRequest,
  ): Promise<{ ok: true; file: ConversationFilePreview }>;
  openConversationFile?(input: ConversationFileRequest): Promise<{ ok: true }>;
  conversationFileUrl(
    input: ConversationFileRequest & { mode?: "download" | "content" },
  ): string;
}
export declare function createConversationFileRequests(options: {
  requestApi: (
    path: string,
    options?: { signal?: AbortSignal; method?: string; body?: string },
  ) => Promise<unknown>;
  resolveApiPath: (path: string) => string;
  origin: string;
  getConfig: () => Record<string, unknown>;
}): ConversationFileClient;
