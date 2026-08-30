import type { MemoryCandidate } from "../contracts.js";

export const MAX_MEMORY_CONTENT_CHARACTERS = 4_000;
export const MAX_MEMORY_ID_CHARACTERS = 128;
export const MAX_MEMORY_TAGS = 12;
export const MAX_MEMORY_TAG_CHARACTERS = 64;

export function normalizeMemoryCandidate(
  candidate: MemoryCandidate,
): MemoryCandidate | undefined {
  const content = normalizeWhitespace(candidate.content).slice(
    0,
    MAX_MEMORY_CONTENT_CHARACTERS,
  );
  if (!content) {
    return undefined;
  }
  const tags = normalizeTags(candidate.tags);
  return Object.freeze({ content, tags });
}

export function normalizeMemoryText(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("und");
}

export function normalizeMemoryIdentifier(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= MAX_MEMORY_ID_CHARACTERS ? id : undefined;
}

export function isMemoryCandidateWithinLimits(
  candidate: MemoryCandidate,
): boolean {
  if (candidate.tags.some((tag) => typeof tag !== "string")) {
    return false;
  }
  const content = normalizeWhitespace(candidate.content);
  const tags = candidate.tags
    .map((tag) => normalizeWhitespace(tag).toLocaleLowerCase("und"))
    .filter(Boolean);
  return (
    content.length <= MAX_MEMORY_CONTENT_CHARACTERS &&
    tags.every((tag) => tag.length <= MAX_MEMORY_TAG_CHARACTERS) &&
    new Set(tags).size <= MAX_MEMORY_TAGS
  );
}

export function mergeMemoryTags(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  return normalizeTags([...left, ...right]);
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  const normalized = tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => normalizeWhitespace(tag).toLocaleLowerCase("und"))
    .filter(Boolean)
    .map((tag) => tag.slice(0, MAX_MEMORY_TAG_CHARACTERS));
  return Object.freeze([...new Set(normalized)].slice(0, MAX_MEMORY_TAGS));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
