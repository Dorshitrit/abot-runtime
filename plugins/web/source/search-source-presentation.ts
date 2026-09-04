import { boundText } from "../../../src/plugin-sdk/index.js";

import { WEB_LIMITS } from "./limits.js";
import {
  renderLightSourceFreshness,
  type LightSearchMetadata,
} from "./light/search-metadata.js";
import type { SearchHit, SourceFetch } from "./search-types.js";
import { renderSourceBlock } from "./source-output-receipts.js";
import { quoteUntrusted } from "./untrusted-text.js";

function sourceRetrieval(source?: SourceFetch) {
  if (source?.page) return "retrieved" as const;
  if (source?.error) return "failed" as const;
  return "not_attempted" as const;
}

function appendSourceContent(lines: string[], source?: SourceFetch) {
  if (source?.page) {
    const bounded = boundText(source.page.text, {
      maxChars: WEB_LIMITS.sourceOutputChars,
      marker: "\n[content truncated]",
    });
    const content = {
      line: lines.length + 1,
      text: bounded.text,
      truncated: source.page.partialContent || bounded.metadata.truncated,
    };
    lines.push(
      "   BEGIN UNTRUSTED FETCHED SOURCE",
      `   content_json: ${quoteUntrusted(bounded.text)}`,
      "   END UNTRUSTED FETCHED SOURCE",
    );
    return content;
  }
  if (source?.error) lines.push(`   Source fetch failed: ${source.error}`);
  return undefined;
}

export function renderSearchSource(
  hit: SearchHit,
  source?: SourceFetch,
  lightSearch?: LightSearchMetadata,
  retrievalSource: SourceFetch | undefined = source,
) {
  const lines = [
    `${hit.rank}. title_json: ${quoteUntrusted(hit.title)}`,
    `   domain_json: ${quoteUntrusted(hit.domain)}`,
    `   url_json: ${quoteUntrusted(hit.url)}`,
    ...renderLightSourceFreshness(hit.url, lightSearch),
  ];
  let snippet: { line: number; text: string } | undefined;
  if (hit.snippet) {
    snippet = { line: lines.length + 1, text: hit.snippet };
    lines.push(
      "   BEGIN UNTRUSTED SEARCH SNIPPET",
      `   snippet_json: ${quoteUntrusted(hit.snippet)}`,
      "   END UNTRUSTED SEARCH SNIPPET",
    );
  }
  const content = appendSourceContent(lines, source);
  const url = retrievalSource?.page?.finalUrl ?? hit.url;
  const requestedUrl = retrievalSource?.page?.requestedUrl ?? hit.url;
  return renderSourceBlock({
    source: {
      url,
      ...(requestedUrl !== url ? { requestedUrl } : {}),
      title: hit.title,
      retrieval: sourceRetrieval(retrievalSource),
    },
    lines,
    referenceLine: 2,
    snippet,
    content,
  });
}
