import { extractFetchedPage } from "../../content.js";
import { WebPluginError } from "../../errors.js";
import { WEB_LIMITS } from "../../limits.js";
import type { PublicHttpResponse } from "../../public-http.js";
import { assertCandidateLimit } from "../discovery/candidate-values.js";
import { parseFeedDocument } from "../discovery/feed-document.js";
import { discoverHtmlLinks } from "../discovery/html-links.js";
import {
  childElements,
  localName,
  parseMarkup,
} from "../discovery/markup-tree.js";
import { parseSitemapDocument } from "../discovery/sitemap-document.js";
import type { LightDocument } from "./document-contract.js";
import { decodeLightDocumentText } from "./document-charset.js";

export type { LightDocument, DiscoveryCandidate } from "./document-contract.js";

function mediaType(response: PublicHttpResponse): string {
  const raw = response.headers["content-type"];
  return ((Array.isArray(raw) ? raw[0] : raw) ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
}

function isXmlSource(type: string, text: string): boolean {
  if (
    [
      "application/xml",
      "text/xml",
      "application/rss+xml",
      "application/atom+xml",
    ].includes(type)
  )
    return true;
  if (type.endsWith("+xml") && type !== "application/xhtml+xml") return true;
  return /^\s*(?:<\?xml[^>]*>\s*)?<(?:[\w.-]+:)?(?:rss|feed|rdf|urlset|sitemapindex)\b/iu.test(
    text,
  );
}

function normalizedPageResponse(
  response: PublicHttpResponse,
  type: string,
  text: string,
): PublicHttpResponse {
  const needsXmlMediaType =
    type.endsWith("+xml") && type !== "application/xhtml+xml";
  const contentType = needsXmlMediaType ? "application/xml" : type;
  return {
    ...response,
    body: Buffer.from(text, "utf8"),
    headers: {
      ...response.headers,
      "content-type": `${contentType}; charset=utf-8`,
    },
  };
}

export function parseLightDocument(
  response: PublicHttpResponse,
  maxCandidates: number,
): LightDocument {
  assertCandidateLimit(maxCandidates);
  if (response.status < 200 || response.status >= 300) {
    throw new WebPluginError(
      "web_fetch_http_error",
      `The source server returned HTTP ${response.status}.`,
    );
  }
  if (response.body.byteLength > WEB_LIMITS.responseBytes) {
    throw new WebPluginError(
      "web_response_invalid",
      "The source exceeds the decoded response limit.",
    );
  }
  const type = mediaType(response);
  const text = decodeLightDocumentText(response);
  const xmlMode = isXmlSource(type, text);
  const isMarkupPage = type === "text/html" || type === "application/xhtml+xml";
  if (xmlMode) {
    const root = parseMarkup(text, true);
    const name = localName(childElements(root)[0] ?? root);
    if (["rss", "feed", "rdf"].includes(name)) {
      const document = parseFeedDocument(
        root,
        response.finalUrl,
        maxCandidates,
      );
      return Object.freeze({
        ...document,
        partial: document.partial || response.partialContent,
      });
    }
    if (["urlset", "sitemapindex"].includes(name)) {
      const document = parseSitemapDocument(
        root,
        response.finalUrl,
        maxCandidates,
      );
      return Object.freeze({
        ...document,
        partial: document.partial || response.partialContent,
      });
    }
  }
  const page = extractFetchedPage(normalizedPageResponse(response, type, text));
  const discovery = isMarkupPage
    ? discoverHtmlLinks(
        parseMarkup(text, false),
        response.finalUrl,
        maxCandidates,
      )
    : { links: Object.freeze([]), partial: false };
  return Object.freeze({
    canonicalUrl: page.finalUrl,
    title: page.title,
    text: page.text,
    kind: "page",
    ...discovery,
    partial: page.partialContent || discovery.partial,
  });
}
