import type { LongTermMemoryRecord, MemoryCandidate } from "./contracts.js";
import {
  mergeMemoryTags,
  normalizeMemoryCandidate,
  normalizeMemoryText,
} from "./policies/normalization.js";
import { containsSensitiveMemoryCandidateData } from "./policies/sensitive-data.js";

export type PreparedMemoryCandidates = Readonly<{
  candidates: readonly MemoryCandidate[];
  rejectedCount: number;
  duplicateCount: number;
}>;

export function prepareMemoryCandidates(
  candidates: readonly MemoryCandidate[],
): PreparedMemoryCandidates {
  const byContent = new Map<string, MemoryCandidate>();
  let rejectedCount = 0;
  let duplicateCount = 0;
  for (const rawCandidate of candidates) {
    const candidate = normalizeMemoryCandidate(rawCandidate);
    if (shouldRejectCandidate(candidate)) {
      rejectedCount += 1;
      continue;
    }
    const key = normalizeMemoryText(candidate.content);
    const duplicate = byContent.get(key);
    if (!duplicate) {
      byContent.set(key, candidate);
      continue;
    }
    duplicateCount += 1;
    byContent.set(
      key,
      Object.freeze({
        content: duplicate.content,
        tags: mergeMemoryTags(duplicate.tags, candidate.tags),
      }),
    );
  }
  return Object.freeze({
    candidates: Object.freeze([...byContent.values()]),
    rejectedCount,
    duplicateCount,
  });
}

export function indexMemoryRecordsByContent(
  records: readonly LongTermMemoryRecord[],
): ReadonlyMap<string, LongTermMemoryRecord> {
  return new Map(
    records.map((record) => [normalizeMemoryText(record.content), record]),
  );
}

function shouldRejectCandidate(
  candidate: MemoryCandidate | undefined,
): candidate is undefined {
  return !candidate || containsSensitiveMemoryCandidateData(candidate);
}
