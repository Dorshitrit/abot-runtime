import type { FetchedPage } from "../../content.js";
import type { LightConfig } from "../config.js";
import type { LightDocument } from "./document-contract.js";

export type LightCachedDocument = Readonly<{
  sourceId: string;
  document: LightDocument;
  fetchedAt: string;
  expiresAt: number;
  page?: FetchedPage;
}>;

type CacheEntry = Readonly<{ value: LightCachedDocument; size: number }>;

export function createDocumentCache(
  config: Pick<LightConfig, "cacheMaxDocuments" | "cacheMaxBytes">,
) {
  const entries = new Map<string, CacheEntry>();
  const aliases = new Map<string, string>();
  let bytes = 0;

  function remove(url: string): void {
    const entry = entries.get(url);
    if (!entry) return;
    bytes -= entry.size;
    entries.delete(url);
    for (const [alias, target] of aliases) {
      if (target === url) aliases.delete(alias);
    }
  }

  function get(url: string, now = Date.now()): LightCachedDocument | undefined {
    const canonical = aliases.get(url) ?? url;
    const entry = entries.get(canonical);
    if (!entry) return undefined;
    if (entry.value.expiresAt <= now) {
      remove(canonical);
      return undefined;
    }
    entries.delete(canonical);
    entries.set(canonical, entry);
    return entry.value;
  }

  function put(
    value: LightCachedDocument,
    requestedUrl: string,
    now = Date.now(),
  ): void {
    const excludedFromIndex = value.document.noIndex === true;
    if (excludedFromIndex) {
      remove(value.document.canonicalUrl);
      return;
    }
    if (value.expiresAt <= now) return;
    if (value.document.partial) return;
    if (config.cacheMaxDocuments === 0) return;
    const size = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (size > config.cacheMaxBytes) return;
    const url = value.document.canonicalUrl;
    remove(url);
    while (
      entries.size >= config.cacheMaxDocuments ||
      bytes + size > config.cacheMaxBytes
    ) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      remove(oldest);
    }
    entries.set(url, { value, size });
    bytes += size;
    aliases.set(requestedUrl, url);
  }

  function forSources(
    sourceIds: ReadonlySet<string>,
    now = Date.now(),
  ): readonly LightCachedDocument[] {
    const values: LightCachedDocument[] = [];
    for (const [url, entry] of entries) {
      if (entry.value.expiresAt <= now) {
        remove(url);
        continue;
      }
      if (sourceIds.has(entry.value.sourceId)) values.push(entry.value);
    }
    return Object.freeze(values);
  }

  return Object.freeze({
    get,
    put,
    forSources,
    size: () => entries.size,
    bytes: () => bytes,
  });
}

export type LightDocumentCache = ReturnType<typeof createDocumentCache>;
