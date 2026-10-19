import { findExactEvidencePath } from "../context/exact-evidence-match.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/contracts.js";
import type { projectExecutionPayloadCompactedEvidence } from "./execution-payload-compacted-evidence.js";

type PayloadSettledResult = ReturnType<
  typeof projectExecutionPayloadCompactedEvidence
>["results"][number];

/** Keep the adapter envelope exact and the pre-projection compaction identity stable. */
export function projectPayloadSettledEvidence(
  results: readonly PayloadSettledResult[],
): Readonly<{
  results: readonly PayloadSettledResult[];
  resultSourceOverrides: readonly SemanticCompactionSource[];
  deduplicatedReferenceDataCount: number;
  deduplicatedReferenceDataChars: number;
}> {
  const resultSourceOverrides: SemanticCompactionSource[] = [];
  let deduplicatedReferenceDataChars = 0;
  const projected = results.map((result) => {
    if (!("adapterResult" in result) || !result.referenceData) return result;
    const representedAt = findExactEvidencePath(
      result.adapterResult,
      result.referenceData,
    );
    if (!representedAt) return result;
    deduplicatedReferenceDataChars += result.referenceData.length;
    const content = JSON.stringify(result);
    resultSourceOverrides.push(Object.freeze({
      sourceRef: `payload-result:${result.executionId}`,
      sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
      content,
    }));
    const { referenceData: _referenceData, ...singleCopyResult } = result;
    return Object.freeze(singleCopyResult);
  });
  return Object.freeze({
    results: Object.freeze(projected),
    resultSourceOverrides: Object.freeze(resultSourceOverrides),
    deduplicatedReferenceDataCount: resultSourceOverrides.length,
    deduplicatedReferenceDataChars,
  });
}
