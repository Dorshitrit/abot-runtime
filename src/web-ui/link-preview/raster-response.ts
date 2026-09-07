import type { PublicHttpResponse } from "../../shared/public-http/public-http.js";

export type PreviewImage = Readonly<{ contentType: string; body: Uint8Array }>;

export function previewMediaType(response: PublicHttpResponse): string {
  return (response.headers["content-type"] ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
}

export function isSuccessfulPreviewResponse(
  response: PublicHttpResponse,
): boolean {
  if (response.status < 200) return false;
  if (response.status >= 300) return false;
  const encoding = response.headers["content-encoding"];
  if (!encoding) return true;
  return encoding.toLowerCase() === "identity";
}

export function isHtmlPreviewResponse(response: PublicHttpResponse): boolean {
  const type = previewMediaType(response);
  return type === "text/html" || type === "application/xhtml+xml";
}

function hasRasterSignature(type: string, bytes: Buffer): boolean {
  if (type === "image/png") {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (type === "image/jpeg") {
    return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  }
  if (type === "image/gif") {
    return ["GIF87a", "GIF89a"].includes(
      bytes.subarray(0, 6).toString("ascii"),
    );
  }
  if (type !== "image/webp") return false;
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF") return false;
  return bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export function readPreviewRaster(
  response: PublicHttpResponse,
): PreviewImage | null {
  if (!isSuccessfulPreviewResponse(response)) return null;
  if (response.partialContent) return null;
  const contentType = previewMediaType(response);
  const body = Buffer.from(response.body);
  if (!hasRasterSignature(contentType, body)) return null;
  return Object.freeze({ contentType, body });
}
