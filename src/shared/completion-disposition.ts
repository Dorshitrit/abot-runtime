/** Optional display metadata; absence retains ordinary completion semantics. */
export type CompletionDisplayDisposition = "blocked";

export function blockedCompletionFields(
  disposition: unknown,
): { disposition?: CompletionDisplayDisposition } {
  if (disposition !== "blocked") return {};
  return { disposition };
}

/** Keep legacy sinks' ordinary one-argument invocation unchanged. */
export function publishCompletedOutput(
  events: {
    completed(
      output: string,
      disposition?: CompletionDisplayDisposition,
    ): void | Promise<void>;
  },
  output: string,
  disposition: unknown,
): void | Promise<void> {
  if (disposition === "blocked") return events.completed(output, "blocked");
  return events.completed(output);
}
