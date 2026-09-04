const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "או",
  "איך",
  "אילו",
  "איזה",
  "את",
  "האם",
  "הוא",
  "היא",
  "הם",
  "זה",
  "זו",
  "מה",
  "מי",
  "מתי",
  "של",
  "על",
  "עם",
]);

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u0591-\u05BD\u05BF-\u05C2\u05C4-\u05C5\u05C7]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function queryTerms(query: string): readonly string[] {
  const terms = normalizeSearchText(query).split(/\s+/u).filter(Boolean);
  const significant = terms.filter((term) => !QUERY_STOP_WORDS.has(term));
  return Object.freeze([...new Set(significant.length ? significant : terms)]);
}

export function textTerms(text: string): readonly string[] {
  return normalizeSearchText(text).split(/\s+/u).filter(Boolean);
}

export function countTermMatches(query: string, text: string): number {
  const available = new Set(textTerms(text));
  return queryTerms(query).filter((term) => available.has(term)).length;
}
