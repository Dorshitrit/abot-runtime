import { extname } from "node:path";

export const MAX_CONVERSATION_TEXT_BYTES = 256 * 1024;
export const MAX_CONVERSATION_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CONVERSATION_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export class ConversationFileError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const BINARY_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".mp3",
  ".mp4",
  ".wav",
  ".mov",
  ".exe",
  ".bin",
  ".gif",
  ".avif",
  ".heic",
  ".ico",
]);

export function rasterImageMimeType(bytes: Buffer): string | undefined {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) !== "RIFF") return undefined;
  return bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
}

function containsBinaryControls(bytes: Buffer): boolean {
  return bytes.some((byte) => byte < 9 || (byte > 13 && byte < 32));
}

export function conversationTextPreview(
  name: string,
  bytes: Buffer,
  truncated: boolean,
): string | undefined {
  if (BINARY_EXTENSIONS.has(extname(name).toLowerCase())) return undefined;
  if (containsBinaryControls(bytes)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: truncated,
    });
  } catch {
    return undefined;
  }
}

export function conversationFileMimeType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export function conversationDownloadDisposition(name: string): string {
  const fallback =
    name.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 180) || "file";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/gu,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return (
    'attachment; filename="' + fallback + "\"; filename*=UTF-8''" + encoded
  );
}
