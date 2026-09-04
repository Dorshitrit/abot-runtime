import { boundText, sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

import { WEB_LIMITS } from "./limits.js";
import { boundUtf8Text } from "./output-budget.js";
import type { WebSourceReceipt } from "./source-receipt-contract.js";
import { quoteUntrusted } from "./untrusted-text.js";

type SourceIdentity = Omit<
  WebSourceReceipt,
  "presentation" | "contentTruncated"
>;
type EvidenceSpan = Readonly<{
  firstCharacterEnd: number;
  end: number;
  truncated: boolean;
}>;
type SourceOccurrence = Readonly<{
  source: SourceIdentity;
  referenceEnd: number;
  snippet?: EvidenceSpan;
  content?: EvidenceSpan;
}>;
type EvidenceLine = Readonly<{
  line: number;
  text: string;
  truncated?: boolean;
}>;
export type RenderedSourceBlock = Readonly<{
  text: string;
  occurrence: SourceOccurrence;
}>;

function lineStart(lines: readonly string[], index: number): number {
  return lines
    .slice(0, index)
    .reduce((length, line) => length + line.length + 1, 0);
}

function firstEncodedCharacterLength(quoted: string): number {
  if (quoted.startsWith('"\\u')) return 6;
  if (quoted.startsWith('"\\')) return 2;
  return String.fromCodePoint(quoted.codePointAt(1)!).length;
}

function evidenceSpan(
  lines: readonly string[],
  evidence?: EvidenceLine,
): EvidenceSpan | undefined {
  if (!evidence?.text.trim()) return undefined;
  const line = lines[evidence.line]!;
  const quoted = quoteUntrusted(evidence.text);
  const start = lineStart(lines, evidence.line) + line.length - quoted.length;
  const leadingWhitespace =
    evidence.text.length - evidence.text.trimStart().length;
  const encodedWhitespace =
    quoteUntrusted(evidence.text.slice(0, leadingWhitespace)).length - 2;
  const meaningfulText = quoteUntrusted(evidence.text.slice(leadingWhitespace));
  return Object.freeze({
    firstCharacterEnd:
      start +
      1 +
      encodedWhitespace +
      firstEncodedCharacterLength(meaningfulText),
    end: start + quoted.length,
    truncated: evidence.truncated ?? false,
  });
}

export function renderSourceBlock(params: {
  source: SourceIdentity;
  lines: readonly string[];
  referenceLine: number;
  snippet?: EvidenceLine;
  content?: EvidenceLine;
}): RenderedSourceBlock {
  return Object.freeze({
    text: params.lines.join("\n"),
    occurrence: Object.freeze({
      source: params.source,
      referenceEnd:
        lineStart(params.lines, params.referenceLine) +
        params.lines[params.referenceLine]!.length,
      snippet: evidenceSpan(params.lines, params.snippet),
      content: evidenceSpan(params.lines, params.content),
    }),
  });
}

function shiftSpan(
  span: EvidenceSpan | undefined,
  offset: number,
): EvidenceSpan | undefined {
  if (!span) return undefined;
  return {
    ...span,
    firstCharacterEnd: span.firstCharacterEnd + offset,
    end: span.end + offset,
  };
}

export function createSourceOutputAssembly() {
  const chunks: string[] = [];
  const occurrences: SourceOccurrence[] = [];
  let length = 0;
  function append(text: string): number {
    const offset = length + (chunks.length > 0 ? 1 : 0);
    chunks.push(text);
    length = offset + text.length;
    return offset;
  }
  return {
    appendLines: (lines: readonly string[]) => {
      if (lines.length > 0) append(lines.join("\n"));
    },
    appendSource: (block: RenderedSourceBlock) => {
      const offset = append(block.text);
      occurrences.push({
        ...block.occurrence,
        referenceEnd: block.occurrence.referenceEnd + offset,
        snippet: shiftSpan(block.occurrence.snippet, offset),
        content: shiftSpan(block.occurrence.content, offset),
      });
    },
    finish: () =>
      Object.freeze({
        text: chunks.join("\n"),
        occurrences: Object.freeze(occurrences),
      }),
  };
}

export function boundSourceOutput(
  value: string,
  params: {
    maxChars?: number;
    maxBytes: number;
    marker: string;
  },
) {
  const byCharacters = boundText(value, {
    maxChars: params.maxChars ?? value.length,
    marker: params.marker,
  });
  const byBytes = boundUtf8Text(byCharacters.text, params);
  const markerChars = boundUtf8Text(params.marker, {
    maxBytes: params.maxBytes,
    marker: "",
  }).text.length;
  const bytePrefixChars = byBytes.truncated
    ? byBytes.text.length - markerChars
    : byBytes.text.length;
  return Object.freeze({
    output: byBytes.text,
    truncated: byCharacters.metadata.truncated || byBytes.truncated,
    visibleChars: Math.min(
      value.length - byCharacters.metadata.omittedChars,
      bytePrefixChars,
    ),
  });
}

function presentedEvidence(
  occurrence: SourceOccurrence,
  visibleChars: number,
): Pick<WebSourceReceipt, "presentation" | "contentTruncated"> {
  if (visibleChars < occurrence.referenceEnd)
    return { presentation: "omitted", contentTruncated: false };
  for (const presentation of ["content", "snippet"] as const) {
    const span = occurrence[presentation];
    if (!span || visibleChars < span.firstCharacterEnd) continue;
    return {
      presentation,
      contentTruncated: span.truncated || visibleChars < span.end,
    };
  }
  return { presentation: "reference", contentTruncated: false };
}

const PRESENTATION_STRENGTH = Object.freeze({
  omitted: 0,
  reference: 1,
  snippet: 2,
  content: 3,
});
const RETRIEVAL_STRENGTH = Object.freeze({
  not_attempted: 0,
  failed: 1,
  retrieved: 2,
});

function hasStrongerPresentation(
  candidate: WebSourceReceipt,
  previous: WebSourceReceipt,
): boolean {
  const difference =
    PRESENTATION_STRENGTH[candidate.presentation] -
    PRESENTATION_STRENGTH[previous.presentation];
  if (difference !== 0) return difference > 0;
  return previous.contentTruncated && !candidate.contentTruncated;
}

function hasBoundedSourceUrl(source: SourceIdentity): boolean {
  if (source.url.length > WEB_LIMITS.upstreamUrlChars) return false;
  if (
    source.requestedUrl &&
    source.requestedUrl.length > WEB_LIMITS.upstreamUrlChars
  )
    return false;
  return true;
}

function hasStrongerRetrieval(
  candidate: WebSourceReceipt,
  previous: WebSourceReceipt,
): boolean {
  return (
    RETRIEVAL_STRENGTH[candidate.retrieval] >
    RETRIEVAL_STRENGTH[previous.retrieval]
  );
}

function mergeSourceReceipt(
  previous: WebSourceReceipt,
  candidate: WebSourceReceipt,
): WebSourceReceipt {
  const presentation = hasStrongerPresentation(candidate, previous)
    ? candidate
    : previous;
  const retrieval = hasStrongerRetrieval(candidate, previous)
    ? candidate
    : previous;
  const { requestedUrl: _requestedUrl, ...visible } = presentation;
  return Object.freeze({
    ...visible,
    retrieval: retrieval.retrieval,
    ...(retrieval.requestedUrl ? { requestedUrl: retrieval.requestedUrl } : {}),
  });
}

export function projectSourceReceipts(
  occurrences: readonly SourceOccurrence[],
  visibleChars: number,
): readonly WebSourceReceipt[] {
  const receipts = new Map<string, WebSourceReceipt>();
  for (const occurrence of occurrences) {
    if (!hasBoundedSourceUrl(occurrence.source)) continue;
    const receipt = Object.freeze({
      ...occurrence.source,
      title: sanitizeJsonText(
        sanitizeJsonText(occurrence.source.title).slice(0, 256),
      ),
      ...presentedEvidence(occurrence, visibleChars),
    });
    const previous = receipts.get(receipt.url);
    if (previous) {
      receipts.set(receipt.url, mergeSourceReceipt(previous, receipt));
      continue;
    }
    if (
      receipts.size >=
      WEB_LIMITS.searchQueries * WEB_LIMITS.searchResultsPerQuery
    )
      continue;
    receipts.set(receipt.url, receipt);
  }
  return Object.freeze([...receipts.values()]);
}
