import type { PublicHttpResponse } from "../../../shared/public-http/public-http.js";

export function previewResponse(
  text = "<head><title>Example</title></head>",
  overrides: Partial<PublicHttpResponse> = {},
): PublicHttpResponse {
  const body = Buffer.from(text);
  return {
    requestedUrl: "https://example.com/page",
    finalUrl: "https://example.com/page",
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
    bytesRead: body.byteLength,
    partialContent: false,
    ...overrides,
  };
}

export function pngResponse(): PublicHttpResponse {
  const body = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a12cAAAAASUVORK5CYII=",
    "base64",
  );
  return previewResponse("", {
    body,
    bytesRead: body.byteLength,
    headers: { "content-type": "image/png" },
    finalUrl: "https://example.com/image.png",
  });
}
