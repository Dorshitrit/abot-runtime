import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from "node:zlib";

import { WebPluginError } from "../../errors.js";
import { WEB_LIMITS } from "../../limits.js";
import type { PublicHttpResponse } from "../../public-http.js";

function responseHeader(response: PublicHttpResponse, name: string): string {
  const value = response.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function responseEncoding(response: PublicHttpResponse): string {
  const declared = responseHeader(response, "content-encoding")
    .trim()
    .toLowerCase();
  if (declared && declared !== "identity") return declared;
  const hasGzipSignature =
    response.body[0] === 0x1f && response.body[1] === 0x8b;
  return hasGzipSignature ? "gzip" : "identity";
}

function hasZlibWrapperHeader(body: Uint8Array): boolean {
  if (body.byteLength < 2) return false;
  const method = body[0]!;
  if ((method & 0x0f) !== 8) return false;
  if (method >> 4 > 7) return false;
  return ((method << 8) + body[1]!) % 31 === 0;
}

function decodeBody(
  body: Uint8Array,
  encoding: string,
  maxOutputLength: number,
): Uint8Array {
  const options = { maxOutputLength };
  if (encoding === "gzip" || encoding === "x-gzip")
    return gunzipSync(body, options);
  if (encoding === "br") return brotliDecompressSync(body, options);
  if (encoding === "deflate") {
    // Select once: a failed wrapper decoder may already have produced output.
    if (hasZlibWrapperHeader(body)) return inflateSync(body, options);
    return inflateRawSync(body, options);
  }
  throw new WebPluginError(
    "web_response_unsupported",
    "The source used an unsupported content encoding.",
  );
}

function decodedContentType(
  response: PublicHttpResponse,
  encoding: string,
): string {
  const original = responseHeader(response, "content-type");
  const mediaType = original.split(";", 1)[0]!.trim().toLowerCase();
  if (encoding === "identity") return original;
  if (["application/gzip", "application/x-gzip"].includes(mediaType))
    return "application/xml";
  if (
    mediaType === "application/octet-stream" &&
    /\.xml\.gz(?:[?#]|$)/iu.test(response.finalUrl)
  ) {
    return "application/xml";
  }
  return original;
}

export function decodeLightResponse(
  response: PublicHttpResponse,
  maxBytes: number,
  consumeDecodedBytes?: (count: number) => void,
): PublicHttpResponse {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const limit = Math.min(maxBytes, WEB_LIMITS.responseBytes);
  if (response.body.byteLength > WEB_LIMITS.responseBytes) {
    throw new WebPluginError(
      "web_response_invalid",
      "The encoded source exceeds the response limit.",
    );
  }
  const encoding = responseEncoding(response);
  let body: Uint8Array;
  try {
    body =
      encoding === "identity"
        ? response.body.subarray(0, limit)
        : decodeBody(response.body, encoding, limit);
  } catch (error) {
    if (error instanceof WebPluginError) throw error;
    // A failed synchronous decoder does not expose its partial output size.
    // Charge its whole allowance so repeated failures cannot evade the budget.
    consumeDecodedBytes?.(limit);
    throw new WebPluginError(
      "web_response_invalid",
      "The encoded source is invalid or exceeds the decoded response limit.",
    );
  }
  consumeDecodedBytes?.(body.byteLength);
  return Object.freeze({
    ...response,
    headers: Object.freeze({
      ...response.headers,
      "content-encoding": "identity",
      "content-length": String(body.byteLength),
      "content-type": decodedContentType(response, encoding),
    }),
    body,
    bytesRead: body.byteLength,
    partialContent:
      response.partialContent ||
      (encoding === "identity" && response.body.byteLength > limit),
  });
}
