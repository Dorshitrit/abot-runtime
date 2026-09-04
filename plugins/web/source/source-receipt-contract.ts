export type WebSourceReceipt = Readonly<{
  url: string;
  requestedUrl?: string;
  title: string;
  retrieval: "not_attempted" | "retrieved" | "failed";
  presentation: "omitted" | "reference" | "snippet" | "content";
  contentTruncated: boolean;
}>;

/** Records the plugin's bounded tool output, never model consumption or citation. */
export type WebSourcesReceipt = Readonly<{
  version: 1;
  operation: "search" | "fetch";
  provider?: "brave" | "light";
  sources: readonly WebSourceReceipt[];
  /** Receipt entries removed to fit metadata bounds; unrelated to presentation. */
  omittedSourceCount?: number;
}>;
