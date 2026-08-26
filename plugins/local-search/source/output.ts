import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

import type { ContentMatch } from "./ripgrep.js";

const MAX_OUTPUT_CHARS = 32_768;

export type SearchEntry =
  | Readonly<{ kind: "name"; value: string }>
  | Readonly<{ kind: "content"; value: ContentMatch }>;

export type BudgetedSearchOutput = Readonly<{
  output: string;
  entries: readonly SearchEntry[];
  metadata: Readonly<{
    truncated: boolean;
    sourceTruncated: boolean;
    candidateItems: number;
    returnedItems: number;
    outputMaxChars: number;
  }>;
}>;

function display(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function render(params: {
  query: string;
  mode: string;
  entries: readonly SearchEntry[];
  truncated: boolean;
}): string {
  const names = params.entries
    .filter(
      (entry): entry is Extract<SearchEntry, { kind: "name" }> =>
        entry.kind === "name",
    )
    .map(({ value }) => `- ${display(value)}`);
  const content = params.entries
    .filter(
      (entry): entry is Extract<SearchEntry, { kind: "content" }> =>
        entry.kind === "content",
    )
    .map(
      ({ value }) =>
        `- ${display(value.path)}:${value.lineNumber}:${sanitizeJsonText(value.text)}`,
    );
  return [
    'Search scope: selected logical path; use "." for the current Worker root.',
    `Query: ${sanitizeJsonText(params.query)}`,
    `Mode: ${params.mode}`,
    `Returned matches: ${params.entries.length}${params.truncated ? " (bounded)" : ""}`,
    ...(names.length > 0 ? ["Filename matches:", ...names] : []),
    ...(content.length > 0 ? ["Content matches:", ...content] : []),
    ...(params.entries.length === 0 ? ["No matches found."] : []),
    ...(params.truncated ? ["Additional matches were omitted."] : []),
  ].join("\n");
}

export function budgetSearchOutput(
  query: string,
  mode: string,
  candidates: readonly SearchEntry[],
  sourceTruncated: boolean,
  fitsSerializedResult: (candidate: BudgetedSearchOutput) => boolean,
): BudgetedSearchOutput {
  const build = (entries: readonly SearchEntry[]): BudgetedSearchOutput => {
    const truncated = sourceTruncated || entries.length < candidates.length;
    return Object.freeze({
      output: render({ query, mode, entries, truncated }),
      entries: Object.freeze([...entries]),
      metadata: Object.freeze({
        truncated,
        sourceTruncated,
        candidateItems: candidates.length,
        returnedItems: entries.length,
        outputMaxChars: MAX_OUTPUT_CHARS,
      }),
    });
  };

  const entries: SearchEntry[] = [];
  for (const candidate of candidates) {
    const tentative = [...entries, candidate];
    const budgeted = build(tentative);
    if (
      budgeted.output.length > MAX_OUTPUT_CHARS ||
      !fitsSerializedResult(budgeted)
    ) {
      break;
    }
    entries.push(candidate);
  }
  const result = build(entries);
  if (!fitsSerializedResult(result)) {
    throw new RangeError(
      "The local-search result envelope exceeds its budget.",
    );
  }
  return result;
}
