import { randomUUID } from "node:crypto";

import { parsePublicHttpUrl } from "../../shared/public-http/network-policy.js";
import {
  createPublicHttpClient,
  type PublicHttpClient,
} from "../../shared/public-http/public-http.js";
import { readLinkPreviewMetadata, type LinkPreview } from "./metadata.js";
import { createPreviewCache } from "./preview-cache.js";
import {
  isHtmlPreviewResponse,
  isSuccessfulPreviewResponse,
  readPreviewRaster,
  type PreviewImage,
} from "./raster-response.js";

const PREVIEW_TTL_MS = 5 * 60_000;
const UNAVAILABLE_TTL_MS = 60_000;
const MAX_PREVIEW_REQUESTS = 8;

export type LinkPreviewService = Readonly<{
  getPreview(rawUrl: string): Promise<LinkPreview | null>;
  getImage(id: string): Promise<PreviewImage | null>;
}>;

function normalizePreviewUrl(rawUrl: string): string {
  if (/[\s\p{Cc}]/u.test(rawUrl))
    throw new Error("Preview URL contains whitespace or controls");
  if (rawUrl.length > 4_096) throw new Error("Preview URL too long");
  const url = parsePublicHttpUrl(rawUrl);
  url.hash = "";
  return url.toString();
}

export function createLinkPreviewService(
  dependencies: {
    httpClient?: PublicHttpClient;
    now?: () => number;
  } = {},
): LinkPreviewService {
  const client = dependencies.httpClient ?? createPublicHttpClient();
  const now = dependencies.now ?? Date.now;
  const previews = createPreviewCache<Promise<LinkPreview | null>>(64, now);
  const imageSources = createPreviewCache<string>(64, now);
  const images = createPreviewCache<Promise<PreviewImage | null>>(32, now);
  let activeRequests = 0;

  const fetchPreviewResource = async (url: string, maxBytes: number) => {
    if (activeRequests >= MAX_PREVIEW_REQUESTS) return null;
    activeRequests += 1;
    try {
      return await client.get({
        url,
        maxBytes,
        maxRedirects: 3,
        timeoutMs: 8_000,
        headers: {
          Accept:
            "text/html,application/xhtml+xml,image/png,image/jpeg,image/gif,image/webp",
          "Accept-Encoding": "identity",
          "User-Agent": "abot-runtime-link-preview/1.0",
        },
      });
    } finally {
      activeRequests -= 1;
    }
  };

  const registerImage = (url: string, image?: PreviewImage): string => {
    const id = randomUUID();
    imageSources.set(id, url, PREVIEW_TTL_MS);
    if (image) images.set(id, Promise.resolve(image), PREVIEW_TTL_MS);
    return `/web-link-preview/image?id=${id}`;
  };

  const loadPreview = async (url: string): Promise<LinkPreview | null> => {
    const response = await fetchPreviewResource(url, 512 * 1024);
    if (!response) return null;
    if (!isSuccessfulPreviewResponse(response)) return null;
    const directImage = readPreviewRaster(response);
    if (directImage) {
      const hostname = new URL(response.finalUrl).hostname;
      return Object.freeze({
        url: response.finalUrl,
        title: hostname,
        description: "",
        siteName: hostname,
        imageUrl: registerImage(response.finalUrl, directImage),
      });
    }
    if (!isHtmlPreviewResponse(response)) return null;
    const preview = readLinkPreviewMetadata(response);
    return Object.freeze({
      ...preview,
      imageUrl: preview.imageUrl ? registerImage(preview.imageUrl) : "",
    });
  };

  const loadImage = async (url: string): Promise<PreviewImage | null> => {
    const response = await fetchPreviewResource(url, 1024 * 1024);
    if (!response) return null;
    return readPreviewRaster(response);
  };

  return Object.freeze({
    async getPreview(rawUrl) {
      let url: string;
      try {
        url = normalizePreviewUrl(rawUrl);
      } catch {
        return null;
      }
      const cached = previews.get(url);
      if (cached) return await cached;
      const pending = loadPreview(url).catch(() => null);
      previews.set(url, pending, PREVIEW_TTL_MS);
      const preview = await pending;
      previews.set(url, pending, preview ? PREVIEW_TTL_MS : UNAVAILABLE_TTL_MS);
      return preview;
    },
    async getImage(id) {
      const url = imageSources.get(id);
      if (!url) return null;
      const cached = images.get(id);
      if (cached) return await cached;
      const pending = loadImage(url).catch(() => null);
      images.set(id, pending, PREVIEW_TTL_MS);
      const image = await pending;
      images.set(id, pending, image ? PREVIEW_TTL_MS : UNAVAILABLE_TTL_MS);
      return image;
    },
  });
}
