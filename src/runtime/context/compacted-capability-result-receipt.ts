import { isReferenceDataRepresentedByAdapterResult } from "./capability-result-compaction-source.js";
import type { RequestToolResult } from "./request-tool-results.js";

type CompactedResultContent = Pick<
  RequestToolResult,
  "adapterResult" | "referenceData" | "summary"
>;

/** Call only after exact source verification; independent supplements remain raw. */
export function projectCompactedCapabilityResultReceipt<
  Result extends CompactedResultContent,
>(result: Result) {
  const { adapterResult: _adapterResult, ...metadata } = result;
  const receipt = {
    ...metadata,
    summary: isSummaryCoveredByCompactedResult(result)
      ? "Result evidence is available in the verified compacted source."
      : result.summary,
  };
  if (!isReferenceDataCoveredByCompactedResult(result))
    return Object.freeze(receipt);
  const { referenceData: _referenceData, ...coveredReceipt } = receipt;
  return Object.freeze(coveredReceipt);
}

function isSummaryCoveredByCompactedResult(
  result: CompactedResultContent,
): boolean {
  if (result.adapterResult?.kind !== "registered_tool_execution_result_v1")
    return false;
  return result.summary === result.adapterResult.result.output;
}

function isReferenceDataCoveredByCompactedResult(
  result: CompactedResultContent,
): boolean {
  if (isReferenceDataRepresentedByAdapterResult(result)) return true;
  if (!result.referenceData) return false;
  if (result.adapterResult?.kind !== "registered_tool_execution_result_v1")
    return false;
  return (
    result.referenceData === result.adapterResult.result.data?.mutationGrounding
  );
}
