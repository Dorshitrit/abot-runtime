import { Parser } from "htmlparser2";

import { parsePublicHttpUrl } from "../../shared/public-http/network-policy.js";
import type { PublicHttpResponse } from "../../shared/public-http/public-http.js";

export type LinkPreview = Readonly<{
  url: string;
  title: string;
  description: string;
  imageUrl: string;
  siteName: string;
}>;

const METADATA_KEYS = new Set([
  "og:title",
  "og:description",
  "og:image",
  "og:site_name",
  "twitter:title",
  "twitter:description",
  "twitter:image",
  "description",
]);

function boundedText(value: string, maxChars: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

function firstMetadata(
  values: Map<string, string>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = values.get(key);
    if (value?.trim()) return value;
  }
  return "";
}

function resolvePreviewImage(raw: string, pageUrl: string): string {
  if (!raw.trim()) return "";
  if (raw.length > 4_096) return "";
  try {
    return parsePublicHttpUrl(new URL(raw, pageUrl).toString()).toString();
  } catch {
    return "";
  }
}

function decodePage(response: PublicHttpResponse): string {
  const contentType = response.headers["content-type"] ?? "";
  const charset =
    /charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(response.body);
  } catch {
    return new TextDecoder().decode(response.body);
  }
}

export function readLinkPreviewMetadata(
  response: PublicHttpResponse,
): LinkPreview {
  const values = new Map<string, string>();
  let title = "";
  let insideTitle = false;
  let headFinished = false;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === "body") headFinished = true;
        if (headFinished) return;
        if (name === "title") insideTitle = true;
        if (name !== "meta") return;
        const key = (
          attributes.property ||
          attributes.name ||
          ""
        ).toLowerCase();
        if (!METADATA_KEYS.has(key)) return;
        if (values.has(key)) return;
        values.set(key, (attributes.content ?? "").slice(0, 4_096));
      },
      ontext(text) {
        if (!insideTitle) return;
        if (headFinished) return;
        title = (title + text).slice(0, 1_024);
      },
      onclosetag(name) {
        if (name === "title") insideTitle = false;
        if (name === "head") headFinished = true;
      },
    },
    { decodeEntities: true },
  );
  parser.end(decodePage(response));
  const hostname = new URL(response.finalUrl).hostname;
  return Object.freeze({
    url: response.finalUrl,
    title:
      boundedText(
        firstMetadata(values, ["og:title", "twitter:title"]) || title,
        200,
      ) || hostname,
    description: boundedText(
      firstMetadata(values, [
        "og:description",
        "twitter:description",
        "description",
      ]),
      320,
    ),
    imageUrl: resolvePreviewImage(
      firstMetadata(values, ["og:image", "twitter:image"]),
      response.finalUrl,
    ),
    siteName:
      boundedText(firstMetadata(values, ["og:site_name"]), 80) || hostname,
  });
}
