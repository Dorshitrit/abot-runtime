import { WebPluginError } from "../../errors.js";
import type { PublicHttpResponse } from "../../public-http.js";

const SUPPORTED_DOCUMENT_ENCODINGS = new Set([
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-1252",
  "windows-1255",
  "iso-8859-8",
  "iso-8859-8-i",
]);
const MAX_ENCODING_LABEL_CHARS = 64;
const XML_DECLARATION_PREFIX_BYTES = 1_024;

function unsupportedDocumentEncoding(): never {
  throw new WebPluginError(
    "web_response_unsupported",
    "The Light source declares an unsupported character encoding.",
  );
}

function byteOrderEncoding(body: Uint8Array): string | undefined {
  const prefix = Buffer.from(body.subarray(0, 4)).toString("hex");
  const isUtf32 = prefix === "fffe0000" || prefix === "0000feff";
  if (isUtf32) return unsupportedDocumentEncoding();
  if (prefix.startsWith("efbbbf")) return "utf-8";
  if (prefix.startsWith("fffe")) return "utf-16le";
  if (prefix.startsWith("feff")) return "utf-16be";
  return undefined;
}

function httpDeclaredEncoding(
  response: PublicHttpResponse,
): string | undefined {
  const raw = response.headers["content-type"];
  const header = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  const declaration =
    /;\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/iu.exec(header);
  if (!declaration) return undefined;
  return declaration[1] ?? declaration[2] ?? declaration[3] ?? "";
}

function xmlDeclaredEncoding(body: Uint8Array): string | undefined {
  const prefix = Buffer.from(
    body.subarray(0, XML_DECLARATION_PREFIX_BYTES),
  ).toString("latin1");
  const declaration =
    /^<\?xml\s[^?]*\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')[^?]*\?>/iu.exec(
      prefix,
    );
  if (!declaration) return undefined;
  return declaration[1] ?? declaration[2] ?? "";
}

function documentDecoder(label: string): TextDecoder {
  const normalized = label.trim();
  if (normalized.length === 0) return unsupportedDocumentEncoding();
  if (normalized.length > MAX_ENCODING_LABEL_CHARS)
    return unsupportedDocumentEncoding();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(normalized, { fatal: true });
  } catch {
    return unsupportedDocumentEncoding();
  }
  const supportedDocumentEncoding = SUPPORTED_DOCUMENT_ENCODINGS.has(
    decoder.encoding,
  );
  if (!supportedDocumentEncoding) return unsupportedDocumentEncoding();
  return decoder;
}

export function decodeLightDocumentText(response: PublicHttpResponse): string {
  const label =
    byteOrderEncoding(response.body) ??
    httpDeclaredEncoding(response) ??
    xmlDeclaredEncoding(response.body) ??
    "utf-8";
  const decoder = documentDecoder(label);
  try {
    return decoder.decode(response.body, { stream: response.partialContent });
  } catch {
    throw new WebPluginError(
      "web_response_invalid",
      "The Light source contains invalid bytes for its character encoding.",
    );
  }
}
