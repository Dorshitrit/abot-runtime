import { createAggregateGate } from "./aggregate-gate.js";
import { remainingTime } from "./deadline.js";
import { PublicHttpError, isPublicHttpError } from "./errors.js";
import { PUBLIC_HTTP_LIMITS } from "./limits.js";
import {
  parsePublicHttpUrl,
  resolvePublicTarget,
  type HostResolver,
} from "./network-policy.js";
import {
  requestPinnedHop,
  type HopRequester,
  type HopResponse,
} from "./request-hop.js";

export { requestPinnedHop };
export type { HopRequester };

export type PublicHttpResponse = HopResponse &
  Readonly<{
    requestedUrl: string;
    finalUrl: string;
  }>;

export type PublicHttpRequest = Readonly<{
  url: string;
  headers?: Readonly<Record<string, string>>;
  maxBytes?: number;
  maxRedirects?: number;
  followRedirects?: boolean;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}>;

export type PublicHttpClient = Readonly<{
  get(request: PublicHttpRequest): Promise<PublicHttpResponse>;
}>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function canFollowHttpRedirect(
  request: PublicHttpRequest,
  status: number,
): boolean {
  if (request.followRedirects === false) return false;
  return REDIRECT_STATUSES.has(status);
}

function redirectLocation(response: HopResponse): string | undefined {
  const raw = response.headers.location;
  return Array.isArray(raw) ? raw[0] : raw;
}

function validateBounds(request: PublicHttpRequest): Readonly<{
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
}> {
  const maxBytes = request.maxBytes ?? PUBLIC_HTTP_LIMITS.responseBytes;
  const maxRedirects = request.maxRedirects ?? PUBLIC_HTTP_LIMITS.redirects;
  const timeoutMs = request.timeoutMs ?? PUBLIC_HTTP_LIMITS.requestTimeoutMs;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError("maxRedirects must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  return Object.freeze({ maxBytes, maxRedirects, timeoutMs });
}

export function createPublicHttpClient(
  dependencies: Readonly<{
    resolveHost?: HostResolver;
    requestHop?: HopRequester;
  }> = {},
): PublicHttpClient {
  const resolveHost = dependencies.resolveHost;
  const requestHop = dependencies.requestHop ?? requestPinnedHop;
  const gate = createAggregateGate(
    PUBLIC_HTTP_LIMITS.httpConcurrency,
    PUBLIC_HTTP_LIMITS.httpQueueLimit,
  );
  return Object.freeze({
    async get(request) {
      const requested = parsePublicHttpUrl(request.url);
      const bounds = validateBounds(request);
      const deadline = Date.now() + bounds.timeoutMs;
      let current = requested;
      for (let redirectCount = 0; ; redirectCount += 1) {
        const address = await gate.run(
          () => resolvePublicTarget(current, resolveHost),
          deadline,
          request.abortSignal,
        );
        const response = await gate.run(
          () =>
            requestHop({
              url: current,
              address,
              headers: Object.freeze({
                Accept:
                  "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,application/xml;q=0.8,text/xml;q=0.8",
                "Accept-Encoding": "identity",
                "User-Agent": "abot-runtime-web/1.0",
                ...(request.headers ?? {}),
              }),
              maxBytes: bounds.maxBytes,
              timeoutMs: remainingTime(deadline),
              ...(request.abortSignal
                ? { abortSignal: request.abortSignal }
                : {}),
            }),
          deadline,
          request.abortSignal,
        );
        if (!canFollowHttpRedirect(request, response.status)) {
          return Object.freeze({
            requestedUrl: requested.toString(),
            finalUrl: current.toString(),
            ...response,
          });
        }
        const location = redirectLocation(response);
        if (!location) {
          throw new PublicHttpError(
            "web_redirect_invalid",
            "The upstream redirect did not provide a valid destination.",
          );
        }
        if (redirectCount >= bounds.maxRedirects) {
          throw new PublicHttpError(
            "web_redirect_limit_exceeded",
            "The web request exceeded the redirect limit.",
          );
        }
        try {
          current = parsePublicHttpUrl(new URL(location, current).toString());
        } catch (error) {
          if (isPublicHttpError(error)) throw error;
          throw new PublicHttpError(
            "web_redirect_invalid",
            "The upstream redirect did not provide a valid destination.",
          );
        }
      }
    },
  });
}
