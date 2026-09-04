import type { FetchedPage } from "./content.js";
import type { WebPluginErrorCode } from "./errors.js";
import type { LightSearchMetadata } from "./light/search-metadata.js";
import type { WebSourcesReceipt } from "./source-receipt-contract.js";

export type SearchHit = Readonly<{
  query: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  rank: number;
}>;

export type QueryResult = Readonly<{
  query: string;
  hits: readonly SearchHit[];
  errorCode?: WebPluginErrorCode;
  error?: string;
}>;

export type SourceFetch = Readonly<{
  hit: SearchHit;
  page?: FetchedPage;
  errorCode?: WebPluginErrorCode;
  error?: string;
}>;

export type SearchCoverage = Readonly<{
  queriesRun: number;
  resultsFound: number;
  uniqueDomains: number;
  sourceFetchesAttempted: number;
  readableSources: number;
  partialSources: number;
  failedSourceFetches: number;
  readableChars: number;
  coverageStatus: "weak" | "partial" | "sufficient";
  outputTruncated: boolean;
}>;

export type SearchExecution = Readonly<{
  webSources: WebSourcesReceipt;
  lightSearch?: LightSearchMetadata;
  queries: readonly string[];
  results: readonly QueryResult[];
  sourceFetches: readonly SourceFetch[];
  hits: readonly SearchHit[];
  coverage: SearchCoverage;
  output: string;
}>;
