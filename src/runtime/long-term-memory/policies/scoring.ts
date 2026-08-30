import type { LongTermMemoryRecord } from "../contracts.js";

const MINIMUM_COSINE_SIMILARITY = 0.25;
const MINIMUM_RELEVANCE_SCORE = 0.4;

export type ScoredMemory = Readonly<{
  record: LongTermMemoryRecord;
  score: number;
}>;

export function scoreMemory(params: {
  record: LongTermMemoryRecord;
  query: string;
  queryVector: readonly number[];
  memoryVector: readonly number[];
  newestTimestampMs: number;
}): ScoredMemory | undefined {
  const cosine = cosineSimilarity(params.queryVector, params.memoryVector);
  if (cosine < MINIMUM_COSINE_SIMILARITY) {
    return undefined;
  }
  const lexical = lexicalOverlap(
    params.query,
    `${params.record.content} ${params.record.tags.join(" ")}`,
  );
  const recency = recencyTieBreaker(
    Date.parse(params.record.updatedAt),
    params.newestTimestampMs,
  );
  const score = cosine * 0.86 + lexical * 0.12 + recency * 0.02;
  return score >= MINIMUM_RELEVANCE_SCORE
    ? Object.freeze({ record: params.record, score })
    : undefined;
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length === 0 || left.length !== right.length) {
    return -1;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const divisor = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return divisor > 0 ? dot / divisor : -1;
}

function lexicalOverlap(query: string, candidate: string): number {
  const queryTerms = tokenize(query);
  if (queryTerms.size === 0) {
    return 0;
  }
  const candidateTerms = tokenize(candidate);
  let matches = 0;
  for (const term of queryTerms) {
    if (candidateTerms.has(term)) {
      matches += 1;
    }
  }
  return matches / queryTerms.size;
}

function tokenize(value: string): ReadonlySet<string> {
  return new Set(
    (value.toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (term) => term.length > 1,
    ),
  );
}

function recencyTieBreaker(timestampMs: number, newestTimestampMs: number): number {
  if (!Number.isFinite(timestampMs) || newestTimestampMs <= 0) {
    return 0;
  }
  const ageDays = Math.max(0, newestTimestampMs - timestampMs) / 86_400_000;
  return 1 / (1 + ageDays / 365);
}
