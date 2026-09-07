import type { LookupFunction } from "node:net";
import {
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as requestHttps } from "node:https";

import { PublicHttpError, isPublicHttpError } from "./errors.js";
import { PUBLIC_HTTP_LIMITS } from "./limits.js";
import type { PublicAddress } from "./network-policy.js";

export type HopResponse = Readonly<{
  status: number;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
  bytesRead: number;
  partialContent: boolean;
}>;

export type HopRequester = (params: {
  url: URL;
  address: PublicAddress;
  headers: Readonly<Record<string, string>>;
  maxBytes: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}) => Promise<HopResponse>;

function buildPinnedLookup(address: PublicAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function contentLength(headers: IncomingHttpHeaders): number | undefined {
  const raw = headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function readBoundedBody(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Readonly<{ body: Uint8Array; partialContent: boolean }>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let settled = false;
    const finish = (partialContent: boolean) => {
      if (settled) return;
      settled = true;
      resolve(
        Object.freeze({
          body: Buffer.concat(chunks, bytesRead),
          partialContent,
        }),
      );
    };
    response.on("data", (rawChunk: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      const remaining = maxBytes - bytesRead;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          bytesRead += remaining;
        }
        finish(true);
        response.destroy();
        return;
      }
      chunks.push(chunk);
      bytesRead += chunk.byteLength;
    });
    response.once("end", () => finish(false));
    response.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    response.once("aborted", () => {
      if (settled) return;
      settled = true;
      reject(
        new PublicHttpError(
          "web_response_invalid",
          "The upstream response ended before completion.",
        ),
      );
    });
  });
}

export const requestPinnedHop: HopRequester = async (params) => {
  if (params.abortSignal?.aborted) {
    throw new PublicHttpError(
      "web_request_aborted",
      "The web request was aborted.",
    );
  }
  return await new Promise<HopResponse>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const requestOptions: RequestOptions = {
      protocol: params.url.protocol,
      hostname: params.url.hostname.replace(/^\[|\]$/gu, ""),
      port: params.url.port || undefined,
      path: `${params.url.pathname}${params.url.search}`,
      method: "GET",
      headers: params.headers,
      lookup: buildPinnedLookup(params.address),
      agent: false,
      maxHeaderSize: PUBLIC_HTTP_LIMITS.responseHeaderBytes,
    };
    const requestFunction =
      params.url.protocol === "https:" ? requestHttps : requestHttp;
    const request = requestFunction(requestOptions, async (response) => {
      try {
        const declaredLength = contentLength(response.headers);
        const body = await readBoundedBody(response, params.maxBytes);
        if (settled) return;
        settled = true;
        resolve(
          Object.freeze({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: body.body,
            bytesRead: body.body.byteLength,
            partialContent:
              body.partialContent ||
              (declaredLength !== undefined &&
                declaredLength > params.maxBytes),
          }),
        );
      } catch (error) {
        if (settled) return;
        settled = true;
        reject(error);
      }
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      request.destroy(
        new PublicHttpError(
          "web_request_timed_out",
          "The upstream web request timed out.",
        ),
      );
    }, params.timeoutMs);
    timeout.unref?.();
    const onAbort = () =>
      request.destroy(
        new PublicHttpError(
          "web_request_aborted",
          "The web request was aborted.",
        ),
      );
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (isPublicHttpError(error)) {
        reject(error);
      } else if (timedOut) {
        reject(
          new PublicHttpError(
            "web_request_timed_out",
            "The upstream web request timed out.",
          ),
        );
      } else {
        reject(
          new PublicHttpError(
            "web_response_invalid",
            "The upstream web request failed.",
          ),
        );
      }
    });
    request.once("close", () => {
      clearTimeout(timeout);
      params.abortSignal?.removeEventListener("abort", onAbort);
    });
    request.end();
  });
};
