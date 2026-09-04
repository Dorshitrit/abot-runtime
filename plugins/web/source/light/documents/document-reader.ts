import type { FetchedPage } from "../../content.js";
import { WebPluginError } from "../../errors.js";
import type { PublicHttpResponse } from "../../public-http.js";
import type { LightConfig } from "../config.js";
import type { LightCrawlSession } from "../crawl/transport.js";
import { documentExpiresAt } from "./cache-policy.js";
import type {
  LightCachedDocument,
  LightDocumentCache,
} from "./document-cache.js";
import { parseLightDocument } from "./extract-document.js";
import { decodeLightResponse } from "./response-decoding.js";

function asFetchedPage(
  record: Omit<LightCachedDocument, "page">,
  response: PublicHttpResponse,
): FetchedPage | undefined {
  if (record.document.kind !== "page") return undefined;
  const type = response.headers["content-type"];
  return Object.freeze({
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    status: response.status,
    contentType: (Array.isArray(type) ? type[0] : type) ?? "",
    title: record.document.title,
    text: record.document.text,
    bytesRead: response.bytesRead,
    partialContent: record.document.partial,
  });
}

export async function readLightDocument(params: {
  url: string;
  sourceId: string;
  session: LightCrawlSession;
  config: LightConfig;
  cache: LightDocumentCache;
}): Promise<Readonly<{ record: LightCachedDocument; fromCache: boolean }>> {
  params.session.assertActive();
  const cached = params.cache.get(params.url);
  if (cached) return Object.freeze({ record: cached, fromCache: true });
  const raw = await params.session.get(params.url);
  if (raw.finalUrl.length > 1_024)
    throw new WebPluginError(
      "web_target_invalid",
      "The Light source URL exceeds 1024 characters.",
    );
  const remaining =
    params.config.maxTotalBytes - params.session.snapshot().decodedBytes;
  if (remaining <= 0)
    throw new WebPluginError(
      "web_search_budget_exhausted",
      "The Light decoded content budget is exhausted.",
    );
  const response = decodeLightResponse(
    raw,
    Math.min(params.config.maxResponseBytes, remaining),
    params.session.consumeDecodedBytes,
  );
  params.session.assertActive();
  const document = parseLightDocument(response, params.config.maxCandidates);
  const now = Date.now();
  const base = Object.freeze({
    sourceId: params.sourceId,
    document,
    fetchedAt: new Date(now).toISOString(),
    expiresAt: documentExpiresAt(response, document.kind, params.config, now),
  });
  const record = Object.freeze({
    ...base,
    page: asFetchedPage(base, response),
  });
  params.cache.put(record, params.url, now);
  return Object.freeze({ record, fromCache: false });
}
