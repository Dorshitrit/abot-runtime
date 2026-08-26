import type { MemoryEntry } from "./types.js";

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function terms(value: string): readonly string[] {
  return Object.freeze([
    ...new Set(
      (normalize(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (term) => term.length >= 2,
      ),
    ),
  ]);
}

function score(query: string, content: string): number {
  const normalizedContent = normalize(content);
  const normalizedQuery = normalize(query);
  if (normalizedQuery && normalizedContent.includes(normalizedQuery))
    return 100;
  return terms(query).reduce(
    (total, term) =>
      normalizedContent.includes(term) ? total + 20 + term.length : total,
    0,
  );
}

export function searchMemory(
  entries: readonly MemoryEntry[],
  query: string,
  maximum: number,
): Readonly<{ matches: readonly MemoryEntry[]; totalMatches: number }> {
  const ranked = entries
    .map((entry) => ({ entry, score: score(query, entry.content) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.createdAt.localeCompare(right.entry.createdAt) ||
        left.entry.id.localeCompare(right.entry.id),
    );
  return Object.freeze({
    matches: Object.freeze(ranked.slice(0, maximum).map(({ entry }) => entry)),
    totalMatches: ranked.length,
  });
}
