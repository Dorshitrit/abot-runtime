import { boundText, sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

import { WebPluginError } from "./errors.js";
import { WEB_LIMITS } from "./limits.js";
import type { PublicHttpResponse } from "./public-http.js";

export type FetchedPage = Readonly<{
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  bytesRead: number;
  partialContent: boolean;
}>;

function decodeEntity(entity: string, original: string): string {
  const named: Readonly<Record<string, string>> = Object.freeze({
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    "#39": "'",
  });
  const normalized = entity.toLowerCase();
  const radix = normalized.startsWith("#x") ? 16 : 10;
  const digits = normalized.startsWith("#x")
    ? normalized.slice(2)
    : normalized.startsWith("#")
      ? normalized.slice(1)
      : "";
  if (digits) {
    const codePoint = Number.parseInt(digits, radix);
    if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return original;
      }
    }
  }
  return named[normalized] ?? original;
}

function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu,
    (match, entity: string) => decodeEntity(entity, match),
  );
}

function getAttribute(tag: string, name: string): string {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"),
  );
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function extractMetaDescription(html: string): string {
  const lower = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const opening = lower.indexOf("<meta", cursor);
    if (opening < 0) break;
    const boundary = lower[opening + 5];
    if (boundary !== ">" && boundary !== "/" && !/\s/u.test(boundary ?? "")) {
      cursor = opening + 5;
      continue;
    }
    const tagEnd = html.indexOf(">", opening + 5);
    if (tagEnd < 0) break;
    const tag = html.slice(opening, tagEnd + 1);
    const name = (
      getAttribute(tag, "name") || getAttribute(tag, "property")
    ).toLowerCase();
    cursor = tagEnd + 1;
    if (name !== "description" && name !== "og:description") continue;
    const value = getAttribute(tag, "content").replace(/\s+/gu, " ").trim();
    if (value) return value;
  }
  return "";
}

const OMITTED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "template",
]);
const BLOCK_ELEMENTS = new Set([
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

function tagName(tag: string): string {
  return tag.match(/^<\/?\s*([a-z0-9-]+)/iu)?.[1]?.toLowerCase() ?? "";
}

function stripHtmlLinear(html: string): string {
  const lower = html.toLowerCase();
  const output: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening < 0) {
      output.push(html.slice(cursor));
      break;
    }
    output.push(html.slice(cursor, opening));
    if (lower.startsWith("<!--", opening)) {
      const commentEnd = lower.indexOf("-->", opening + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tagEnd = html.indexOf(">", opening + 1);
    if (tagEnd < 0) {
      output.push(html.slice(opening));
      break;
    }
    const rawTag = html.slice(opening, tagEnd + 1);
    const name = tagName(rawTag);
    const closing = /^<\//u.test(rawTag);
    if (!closing && OMITTED_ELEMENTS.has(name)) {
      const closeStart = lower.indexOf(`</${name}`, tagEnd + 1);
      if (closeStart < 0) {
        cursor = html.length;
        continue;
      }
      const closeEnd = html.indexOf(">", closeStart + name.length + 2);
      cursor = closeEnd < 0 ? html.length : closeEnd + 1;
      continue;
    }
    output.push(BLOCK_ELEMENTS.has(name) ? "\n" : " ");
    cursor = tagEnd + 1;
  }
  return output.join("");
}

function htmlToText(html: string): string {
  return sanitizeJsonText(decodeHtmlEntities(stripHtmlLinear(html)))
    .split(/\r?\n/gu)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function firstElementBlock(html: string, name: "article" | "main"): string {
  const lower = html.toLowerCase();
  let opening = lower.indexOf(`<${name}`);
  while (opening >= 0) {
    const boundary = lower[opening + name.length + 1];
    if (boundary === ">" || boundary === "/" || /\s/u.test(boundary ?? "")) {
      const openingEnd = lower.indexOf(">", opening + name.length + 1);
      if (openingEnd < 0) return "";
      const closing = lower.indexOf(`</${name}>`, openingEnd + 1);
      return closing < 0 ? "" : html.slice(opening, closing + name.length + 3);
    }
    opening = lower.indexOf(`<${name}`, opening + name.length + 1);
  }
  return "";
}

function firstElementContent(html: string, name: string): string {
  const lower = html.toLowerCase();
  let opening = lower.indexOf(`<${name}`);
  while (opening >= 0) {
    const boundary = lower[opening + name.length + 1];
    if (boundary === ">" || boundary === "/" || /\s/u.test(boundary ?? "")) {
      const openingEnd = lower.indexOf(">", opening + name.length + 1);
      if (openingEnd < 0) return "";
      const closing = lower.indexOf(`</${name}>`, openingEnd + 1);
      return closing < 0 ? "" : html.slice(openingEnd + 1, closing);
    }
    opening = lower.indexOf(`<${name}`, opening + name.length + 1);
  }
  return "";
}

function extractHtml(html: string): Readonly<{ title: string; text: string }> {
  const title = sanitizeJsonText(
    decodeHtmlEntities(firstElementContent(html, "title"))
      .replace(/\s+/gu, " ")
      .trim(),
  );
  const description = sanitizeJsonText(extractMetaDescription(html));
  const articleBlocks = [
    firstElementBlock(html, "article"),
    firstElementBlock(html, "main"),
  ]
    .filter(Boolean)
    .map(htmlToText)
    .filter((text) => text.length >= 160)
    .sort((left, right) => right.length - left.length);
  const body = articleBlocks[0] ?? htmlToText(html);
  return Object.freeze({
    title: boundText(title, {
      maxChars: WEB_LIMITS.upstreamTitleChars,
      marker: "...",
    }).text,
    text: [description, body].filter(Boolean).join("\n"),
  });
}

function normalizedContentType(headers: PublicHttpResponse["headers"]): string {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function assertSupportedContentType(contentType: string): void {
  const supported =
    contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    contentType === "text/plain" ||
    contentType === "text/markdown" ||
    contentType === "text/xml" ||
    contentType === "application/xml" ||
    contentType === "application/json" ||
    contentType.endsWith("+json");
  if (!supported) {
    throw new WebPluginError(
      "web_response_unsupported",
      "The upstream response is not a supported textual content type.",
    );
  }
}

function assertIdentityEncoding(headers: PublicHttpResponse["headers"]): void {
  const raw = headers["content-encoding"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (value && value !== "identity") {
    throw new WebPluginError(
      "web_response_unsupported",
      "The upstream response used an unsupported content encoding.",
    );
  }
}

export function extractFetchedPage(response: PublicHttpResponse): FetchedPage {
  assertIdentityEncoding(response.headers);
  const contentType = normalizedContentType(response.headers);
  assertSupportedContentType(contentType);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
    response.body,
  );
  const extracted =
    contentType === "text/html" || contentType === "application/xhtml+xml"
      ? extractHtml(decoded)
      : Object.freeze({ title: "", text: sanitizeJsonText(decoded).trim() });
  const bounded = boundText(extracted.text, {
    maxChars: WEB_LIMITS.pageOutputChars,
    marker: "\n[content truncated]",
  });
  return Object.freeze({
    requestedUrl: response.requestedUrl,
    finalUrl: response.finalUrl,
    status: response.status,
    contentType,
    title: extracted.title,
    text: bounded.text,
    bytesRead: response.bytesRead,
    partialContent: response.partialContent || bounded.metadata.truncated,
  });
}
