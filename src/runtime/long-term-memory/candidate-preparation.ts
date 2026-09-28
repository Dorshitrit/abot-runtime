import type { MemoryCandidate } from "./contracts.js";
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
      byContent.set(key, { ...candidate, ...(rawCandidate.assessment ? { assessment: rawCandidate.assessment } : {}) });
      continue;
    }
    duplicateCount += 1;
    const assessment = rawCandidate.assessment?.explicitlyRequested
      ? rawCandidate.assessment
      : duplicate.assessment;
    byContent.set(
      key,
      Object.freeze({
        content: duplicate.content,
        tags: mergeMemoryTags(duplicate.tags, candidate.tags),
        ...(assessment ? { assessment } : {}),
      }),
    );
  }
  return Object.freeze({
    candidates: Object.freeze([...byContent.values()]),
    rejectedCount,
    duplicateCount,
  });
}

function shouldRejectCandidate(
  candidate: MemoryCandidate | undefined,
): candidate is undefined {
  return !candidate || containsSensitiveMemoryCandidateData(candidate);
}
