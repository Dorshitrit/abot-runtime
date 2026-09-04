import type {
  LightDocument,
  DiscoveryCandidate,
} from "../documents/document-contract.js";
import {
  elementBaseUrl,
  normalizedSourceDate,
  resolveDiscoveryUrl,
} from "./candidate-values.js";
import {
  childElements,
  elementText,
  firstChildText,
  localName,
  type MarkupElement,
} from "./markup-tree.js";

export function parseSitemapDocument(
  root: MarkupElement,
  documentUrl: string,
  maxCandidates: number,
): LightDocument {
  const container = childElements(root)[0] ?? root;
  const isSitemapIndex = localName(container) === "sitemapindex";
  const expectedEntryName = isSitemapIndex ? "sitemap" : "url";
  const links: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  let partial = false;
  for (const entry of childElements(container)) {
    if (localName(entry) !== expectedEntryName) continue;
    const location = childElements(entry).find(
      (child) => localName(child) === "loc",
    );
    if (!location) continue;
    const url = resolveDiscoveryUrl(
      elementText(location),
      elementBaseUrl(location, documentUrl),
    );
    if (!url || seen.has(url)) continue;
    if (links.length >= maxCandidates) {
      partial = true;
      break;
    }
    const updatedAt = normalizedSourceDate(firstChildText(entry, ["lastmod"]));
    seen.add(url);
    links.push(
      Object.freeze({
        url,
        title: "",
        kind: isSitemapIndex ? "sitemap" : "page",
        ...(updatedAt ? { updatedAt } : {}),
      }),
    );
  }
  return Object.freeze({
    canonicalUrl: documentUrl,
    title: "",
    text: "",
    kind: "sitemap",
    links: Object.freeze(links),
    partial,
  });
}
