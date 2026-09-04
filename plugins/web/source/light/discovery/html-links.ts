import type { DiscoveryCandidate } from "../documents/document-contract.js";
import {
  boundedDiscoveryText,
  resolveDiscoveryUrl,
} from "./candidate-values.js";
import {
  descendants,
  elementText,
  localName,
  type MarkupElement,
} from "./markup-tree.js";
import { readOriginDates } from "./origin-dates.js";
import { readHtmlRobotsDirectives } from "./html-robots-directives.js";

export type HtmlDiscovery = Readonly<{
  links: readonly DiscoveryCandidate[];
  partial: boolean;
  noIndex: boolean;
  publishedAt?: string;
  updatedAt?: string;
}>;

function relationTokens(element: MarkupElement): readonly string[] {
  return (element.attributes.rel ?? "").toLowerCase().split(/\s+/u);
}

function isFeedAdvertisement(element: MarkupElement): boolean {
  if (localName(element) !== "link") return false;
  if (!relationTokens(element).includes("alternate")) return false;
  return ["application/rss+xml", "application/atom+xml"].includes(
    (element.attributes.type ?? "").toLowerCase().split(";", 1)[0]!.trim(),
  );
}

export function discoverHtmlLinks(
  root: MarkupElement,
  documentUrl: string,
  maxCandidates: number,
): HtmlDiscovery {
  const elements = descendants(root);
  const baseElement = elements.find(
    (element) => localName(element) === "base" && !!element.attributes.href,
  );
  const base =
    resolveDiscoveryUrl(baseElement?.attributes.href ?? "", documentUrl) ??
    documentUrl;
  const links: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  let partial = false;
  const robots = readHtmlRobotsDirectives(elements);
  for (const element of elements) {
    if (robots.noFollow) break;
    const isFeed = isFeedAdvertisement(element);
    if (!isFeed && localName(element) !== "a") continue;
    if (relationTokens(element).includes("nofollow")) continue;
    const url = resolveDiscoveryUrl(element.attributes.href ?? "", base);
    if (!url || seen.has(url)) continue;
    if (links.length >= maxCandidates) {
      partial = true;
      break;
    }
    seen.add(url);
    links.push(
      Object.freeze({
        url,
        title: boundedDiscoveryText(
          element.attributes.title ?? elementText(element),
          180,
        ),
        kind: isFeed ? "feed" : "page",
      }),
    );
  }
  return Object.freeze({
    links: Object.freeze(links),
    partial,
    noIndex: robots.noIndex,
    ...readOriginDates(elements),
  });
}
