import type { RequestToolResult } from "./request-tool-results.js";

type OutputSummary = Pick<RequestToolResult, "summary" | "adapterResult">;

export function isSummaryRepresentedByRegisteredOutput(
  result: OutputSummary,
): boolean {
  if (result.adapterResult?.kind !== "registered_tool_execution_result_v1")
    return false;
  return result.summary === result.adapterResult.result.output;
}

/** Display-only projection; canonical receipts and source bytes keep summary. */
export function projectSingleCopyOutputSummary<T extends OutputSummary>(
  result: T,
): Omit<T, "summary"> & { readonly summary?: string } {
  if (!isSummaryRepresentedByRegisteredOutput(result)) return result;
  const { summary: _summary, ...singleCopy } = result;
  return Object.freeze(singleCopy);
}
