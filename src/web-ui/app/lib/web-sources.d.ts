export type WebSourceRetrieval = "not_attempted" | "retrieved" | "failed";
export type WebSourcePresentation =
  | "omitted"
  | "reference"
  | "snippet"
  | "content";
export type WebSource = {
  url: string;
  requestedUrl?: string;
  title: string;
  retrieval: WebSourceRetrieval;
  presentation: WebSourcePresentation | "unknown";
  contentTruncated: boolean;
};
export type WebSourcesReceipt = {
  version: 0 | 1;
  operation: "search" | "fetch";
  provider?: "brave" | "light";
  sources: WebSource[];
  omittedSourceCount?: number;
};
export type ConversationSourcesGroup = WebSourcesReceipt & {
  id: string;
  callId: string;
};
export declare function normalizeWebSources(
  value: unknown,
  toolName: unknown,
): WebSourcesReceipt | null;
export declare function normalizeLegacyWebSources(
  value: unknown,
  toolName: unknown,
): WebSourcesReceipt | null;
export declare function buildConversationSources(
  events?: unknown[],
): ConversationSourcesGroup[];
