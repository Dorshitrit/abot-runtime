import {
  readRequiredString,
  readStringArray,
  type ToolCallAdapter,
} from "../../../src/plugin-sdk/index.js";

import { WEB_LIMITS } from "./limits.js";
import { parsePublicHttpUrl } from "./network-policy.js";

type ValidationIssue = Readonly<{
  error: string;
  repairHint: string;
}>;

type ValidationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; issue: ValidationIssue }>;

const SEARCH_REPAIR_HINT =
  "Do not retry this call unchanged. Provide query for one non-empty web query, or queries for up to five distinct non-empty web queries.";
const FETCH_REPAIR_HINT =
  "Do not retry this call unchanged. Provide url for one absolute public http(s) URL, or urls for up to three such URLs.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(params).some((key) => !allowedKeys.has(key))) {
    throw new TypeError("unsupported parameter");
  }
}

function assertBraveQueryBounds(query: string): string {
  const wordCount = query.split(/\s+/u).filter(Boolean).length;
  if (
    query.length > WEB_LIMITS.queryMaxChars ||
    wordCount > WEB_LIMITS.queryMaxWords
  ) {
    throw new TypeError("query exceeds Brave Search limits");
  }
  return query;
}

export function parseSearchParams(params: unknown): readonly string[] {
  if (!isRecord(params)) throw new TypeError("params must be an object");
  assertAllowedKeys(params, ["query", "queries"]);
  const hasQuery = params.query !== undefined;
  const hasQueries = params.queries !== undefined;
  if (hasQuery === hasQueries) {
    throw new TypeError("provide exactly one of query or queries");
  }
  const values = hasQuery
    ? [
        readRequiredString(params.query, {
          name: "query",
          maxLength: WEB_LIMITS.queryMaxChars,
        }),
      ]
    : readStringArray(params.queries, {
        name: "queries",
        minItems: 1,
        maxItems: WEB_LIMITS.searchQueries,
        maxItemLength: WEB_LIMITS.queryMaxChars,
      });
  return Object.freeze(values.map(assertBraveQueryBounds));
}

export function parseFetchParams(params: unknown): readonly string[] {
  if (!isRecord(params)) throw new TypeError("params must be an object");
  assertAllowedKeys(params, ["url", "urls"]);
  const hasUrl = params.url !== undefined;
  const hasUrls = params.urls !== undefined;
  if (hasUrl === hasUrls) {
    throw new TypeError("provide exactly one of url or urls");
  }
  const urls = hasUrl
    ? Object.freeze([
        readRequiredString(params.url, {
          name: "url",
          maxLength: WEB_LIMITS.upstreamUrlChars,
        }),
      ])
    : readStringArray(params.urls, {
        name: "urls",
        minItems: 1,
        maxItems: WEB_LIMITS.fetchUrls,
        maxItemLength: WEB_LIMITS.upstreamUrlChars,
      });
  for (const url of urls) parsePublicHttpUrl(url);
  return urls;
}

function validate<T>(
  parse: () => T,
  error: string,
  repairHint: string,
): ValidationResult<T> {
  try {
    return Object.freeze({ ok: true, value: parse() });
  } catch {
    return Object.freeze({
      ok: false,
      issue: Object.freeze({ error, repairHint }),
    });
  }
}

export function validateSearchParams(
  params: unknown,
): ValidationResult<readonly string[]> {
  return validate(
    () => parseSearchParams(params),
    "web_search requires exactly one valid query or queries value within Brave Search limits.",
    SEARCH_REPAIR_HINT,
  );
}

export function validateFetchParams(
  params: unknown,
): ValidationResult<readonly string[]> {
  return validate(
    () => parseFetchParams(params),
    "web_fetch requires exactly one valid public http(s) url or urls value.",
    FETCH_REPAIR_HINT,
  );
}

function adapterValidation(
  validation: ValidationResult<unknown>,
): ValidationIssue | null {
  return validation.ok ? null : validation.issue;
}

export const webSearchCallAdapter: ToolCallAdapter = Object.freeze({
  validateCall: ({ params }) => adapterValidation(validateSearchParams(params)),
});

export const webFetchCallAdapter: ToolCallAdapter = Object.freeze({
  validateCall: ({ params }) => adapterValidation(validateFetchParams(params)),
});
