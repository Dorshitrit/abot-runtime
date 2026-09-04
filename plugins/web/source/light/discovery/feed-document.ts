import type {
  LightDocument,
  DiscoveryCandidate,
} from "../documents/document-contract.js";
import {
  boundedDiscoveryText,
  elementBaseUrl,
  normalizedSourceDate,
  resolveDiscoveryUrl,
} from "./candidate-values.js";
import {
  childElements,
  descendants,
  elementText,
  firstChildText,
  localName,
  parseMarkup,
  type MarkupElement,
} from "./markup-tree.js";

function feedEntryUrl(
  entry: MarkupElement,
  documentUrl: string,
): string | undefined {
  const children = childElements(entry);
  const link = children.find((child) => {
    if (localName(child) !== "link") return false;
    const relation = child.attributes.rel?.toLowerCase();
    return !relation || relation === "alternate";
  });
  if (link) {
    const value = link.attributes.href ?? elementText(link);
    const resolved = resolveDiscoveryUrl(
      value,
      elementBaseUrl(link, documentUrl),
    );
    if (resolved) return resolved;
  }
  const guid = children.find((child) => localName(child) === "guid");
  if (!guid || guid.attributes.isPermaLink?.toLowerCase() === "false")
    return undefined;
  return resolveDiscoveryUrl(
    elementText(guid),
    elementBaseUrl(guid, documentUrl),
  );
}

function readableFeedExcerpt(entry: MarkupElement): string {
  const raw = firstChildText(entry, [
    "description",
    "summary",
    "content",
    "encoded",
  ]).slice(0, 8_000);
  if (!raw.includes("<")) return boundedDiscoveryText(raw);
  return boundedDiscoveryText(elementText(parseMarkup(raw, false)));
}

function feedCandidate(
  entry: MarkupElement,
  documentUrl: string,
): DiscoveryCandidate | undefined {
  const url = feedEntryUrl(entry, documentUrl);
  if (!url) return undefined;
  const publishedAt = normalizedSourceDate(
    firstChildText(entry, ["published", "pubdate", "date"]),
  );
  const updatedAt = normalizedSourceDate(
    firstChildText(entry, ["updated", "modified"]),
  );
  const text = readableFeedExcerpt(entry);
  return Object.freeze({
    url,
    title: boundedDiscoveryText(firstChildText(entry, ["title"]), 180),
    kind: "page",
    ...(text ? { text } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  });
}

export function parseFeedDocument(
  root: MarkupElement,
  documentUrl: string,
  maxCandidates: number,
): LightDocument {
  const elements = descendants(root);
  const container =
    elements.find((element) => localName(element) === "channel") ??
    childElements(root)[0] ??
    root;
  const entries = elements.filter((element) =>
    ["item", "entry"].includes(localName(element)),
  );
  const links: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  let partial = false;
  for (const entry of entries) {
    const candidate = feedCandidate(entry, documentUrl);
    if (!candidate || seen.has(candidate.url)) continue;
    if (links.length >= maxCandidates) {
      partial = true;
      break;
    }
    seen.add(candidate.url);
    links.push(candidate);
  }
  const publishedAt = normalizedSourceDate(
    firstChildText(container, ["published", "pubdate", "date"]),
  );
  const updatedAt = normalizedSourceDate(
    firstChildText(container, ["updated", "lastbuilddate"]),
  );
  return Object.freeze({
    canonicalUrl: documentUrl,
    title: boundedDiscoveryText(firstChildText(container, ["title"]), 180),
    text: boundedDiscoveryText(
      firstChildText(container, ["description", "subtitle"]),
      1_200,
    ),
    kind: "feed",
    links: Object.freeze(links),
    partial,
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  });
}
