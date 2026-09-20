export interface ConversationFileOutput {
  version: 1;
  location: "agent_work" | "workspace";
  rootId: string;
  relativePath: string;
  logicalPath: string;
  operation: "created" | "updated";
}
export interface ConversationFileReference {
  requestId: string;
  executionId: string;
  output: ConversationFileOutput;
}
export declare function parseConversationFileOutput(
  value: unknown,
): ConversationFileOutput | null;
export declare function parseConversationFileReference(
  value: unknown,
): ConversationFileReference | null;
export declare function projectConversationFileReference(
  message: Record<string, unknown>,
): ConversationFileReference | null;
export declare function canViewConversationFile(
  action: {
    id: string;
    status: string;
    fileReference?: unknown;
  },
  requestId: string,
): boolean;
