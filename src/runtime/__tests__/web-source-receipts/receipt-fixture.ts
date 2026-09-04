import type { FetchedPage } from "../../../../plugins/web/source/content.js";
import { coverageFor } from "../../../../plugins/web/source/research.js";
import { buildSearchPresentation } from "../../../../plugins/web/source/search-presentation.js";
import type {
  QueryResult,
  SearchHit,
  SourceFetch,
} from "../../../../plugins/web/source/search-types.js";

export function hit(index = 0, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    query: "topic",
    title: `Source ${index}`,
    url: `https://source.example/${index}`,
    domain: "source.example",
    snippet: "A relevant snippet.",
    rank: index + 1,
    ...overrides,
  };
}

export function page(
  url = "https://source.example/0",
  overrides: Partial<FetchedPage> = {},
): FetchedPage {
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: "text/html",
    title: "Page title",
    text: "The readable source content.",
    bytesRead: 50,
    partialContent: false,
    ...overrides,
  };
}

export function presentSearch(
  hits: readonly SearchHit[],
  sourceFetches: readonly SourceFetch[] = [],
  results?: readonly QueryResult[],
) {
  const queryResults = results ?? [{ query: "topic", hits }];
  return buildSearchPresentation({
    results: queryResults,
    sourceFetches,
    coverage: coverageFor({
      results: queryResults,
      hits,
      sourceFetches,
      outputTruncated: false,
    }),
  });
}
