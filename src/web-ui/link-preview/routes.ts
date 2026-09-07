import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createLinkPreviewService,
  type LinkPreviewService,
} from "./service.js";

function isMatchingPreviewOrigin(
  rawOrigin: string,
  request: IncomingMessage,
): boolean {
  const host = request.headers.host;
  if (!host) return false;
  try {
    const origin = new URL(rawOrigin);
    const protocol = "encrypted" in request.socket ? "https:" : "http:";
    if (origin.protocol !== protocol) return false;
    return origin.host === host;
  } catch {
    return false;
  }
}

function isSameOriginPreviewRequest(request: IncomingMessage): boolean {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "same-origin") return true;
  if (fetchSite) return false;
  const origin = request.headers.origin;
  if (origin) return isMatchingPreviewOrigin(origin, request);
  const referer = request.headers.referer;
  if (referer) return isMatchingPreviewOrigin(referer, request);
  return false;
}

function sendUnavailable(response: ServerResponse, status = 200): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ ok: false, error: "preview_unavailable" }));
}

function isExplicitMetadataRequest(request: IncomingMessage): boolean {
  return request.headers["x-abot-link-preview"] === "1";
}

async function servePreviewMetadata(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: LinkPreviewService,
): Promise<void> {
  if (!isExplicitMetadataRequest(request)) {
    sendUnavailable(response, 403);
    return;
  }
  const preview = await service.getPreview(url.searchParams.get("url") ?? "");
  if (!preview) {
    sendUnavailable(response);
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ ok: true, preview }));
}

async function servePreviewImage(
  response: ServerResponse,
  url: URL,
  service: LinkPreviewService,
): Promise<void> {
  const image = await service.getImage(url.searchParams.get("id") ?? "");
  if (!image) {
    sendUnavailable(response, 404);
    return;
  }
  response.writeHead(200, {
    "content-type": image.contentType,
    "content-length": image.body.byteLength,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
  });
  response.end(image.body);
}

export function createLinkPreviewRouteHandler(
  service: LinkPreviewService = createLinkPreviewService(),
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const url = new URL(request.url || "/", "http://localhost");
    const isMetadataRoute = url.pathname === "/web-link-preview";
    const isImageRoute = url.pathname === "/web-link-preview/image";
    if (!isMetadataRoute && !isImageRoute) return false;
    if (request.method !== "GET") {
      sendUnavailable(response, 405);
      return true;
    }
    if (!isSameOriginPreviewRequest(request)) {
      sendUnavailable(response, 403);
      return true;
    }
    if (isMetadataRoute) {
      await servePreviewMetadata(request, response, url, service);
      return true;
    }
    await servePreviewImage(response, url, service);
    return true;
  };
}
