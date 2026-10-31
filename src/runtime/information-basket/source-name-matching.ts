import { extname } from "node:path";

const SOURCE_NAME_DELIMITER = /[\s"'`()\[\]{}<>:;,!?\/\\\u2018\u2019\u201c\u201d\u2013\u2014]/u;

function normalizeBasketSourceNameText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function hasBasketSourceNameStartBoundary(text: string, start: number): boolean {
  if (start === 0) return true;
  return SOURCE_NAME_DELIMITER.test(text[start - 1]!);
}

function hasBasketSourceNameEndBoundary(text: string, end: number): boolean {
  const suffix = text.slice(end);
  if (!suffix) return true;
  if (SOURCE_NAME_DELIMITER.test(suffix[0]!)) return true;
  // Sentence punctuation is allowed, but another extension such as .bak is not.
  if (!suffix.startsWith(".")) return false;
  const afterPeriods = suffix.replace(/^\.+/u, "");
  if (!afterPeriods) return true;
  return SOURCE_NAME_DELIMITER.test(afterPeriods[0]!);
}

function hasCompleteBasketSourceNameBoundaries(text: string, start: number, length: number): boolean {
  if (!hasBasketSourceNameStartBoundary(text, start)) return false;
  return hasBasketSourceNameEndBoundary(text, start + length);
}

function hasCompleteBasketSourceNameMatch(text: string, name: string): boolean {
  let start = text.indexOf(name);
  while (start !== -1) {
    if (hasCompleteBasketSourceNameBoundaries(text, start, name.length)) return true;
    start = text.indexOf(name, start + 1);
  }
  return false;
}

function basketNameWordPairs(text: string): readonly Readonly<{ key: string; start: number; end: number }>[] {
  const words = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)];
  return words.slice(1).flatMap((word, index) => {
    const previous = words[index]!;
    const start = previous.index;
    const end = word.index + word[0].length;
    const separator = text.slice(start + previous[0].length, word.index);
    if (!hasBasketNameWordSeparator(separator)) return [];
    return [{ key: JSON.stringify([previous[0], word[0]]), start, end }];
  });
}

function hasBasketNameWordSeparator(separator: string): boolean {
  return /^[\s_\-\u2013\u2014]+$/u.test(separator);
}

function hasBasketWordSequenceStartBoundary(text: string, start: number): boolean {
  if (hasBasketSourceNameStartBoundary(text, start)) return true;
  return hasBasketNameWordSeparator(text.slice(start - 1, start));
}

function hasBasketWordSequenceEndBoundary(text: string, end: number): boolean {
  if (hasBasketSourceNameEndBoundary(text, end)) return true;
  return hasBasketNameWordSeparator(text.slice(end, end + 1));
}

function hasBasketSourceWordSequence(text: string, name: string): boolean {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  const pairs = new Set(basketNameWordPairs(stem).map(pair => pair.key));
  if (!pairs.size) return false;
  return basketNameWordPairs(text).some(pair => {
    if (!pairs.has(pair.key)) return false;
    if (!hasBasketWordSequenceStartBoundary(text, pair.start)) return false;
    return hasBasketWordSequenceEndBoundary(text, pair.end);
  });
}

/** Name priority is separate from content similarity: complete name, word sequence, or none. */
export function basketSourceNameMatchRank(query: string, displayName: string): 0 | 1 | 2 {
  const name = normalizeBasketSourceNameText(displayName);
  if (!name) return 0;
  const text = normalizeBasketSourceNameText(query);
  if (hasCompleteBasketSourceNameMatch(text, name)) return 2;
  if (hasBasketSourceWordSequence(text, name)) return 1;
  return 0;
}
