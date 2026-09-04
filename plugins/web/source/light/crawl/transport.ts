import { WebPluginError } from "../../errors.js";
import { parsePublicHttpUrl } from "../../network-policy.js";
import { WEB_LIMITS } from "../../limits.js";
import type {
  PublicHttpClient,
  PublicHttpResponse,
} from "../../public-http.js";
import type { LightConfig } from "../config.js";
import { createOriginGate } from "./origin-gate.js";
import { createRobotsPolicy } from "./robots-policy.js";
import {
  createSessionBudget,
  type LightCrawlSnapshot,
} from "./session-budget.js";

export type LightCrawlSession = Readonly<{
  get(url: string): Promise<PublicHttpResponse>;
  canContinue(): boolean;
  assertActive(): void;
  consumeDecodedBytes(count: number): void;
  snapshot(): LightCrawlSnapshot;
  sitemapsFor(origin: string): readonly string[];
  dispose(): void;
}>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseLightUrl(raw: string): URL {
  if (raw.length > WEB_LIMITS.upstreamUrlChars) {
    throw new WebPluginError(
      "web_target_invalid",
      "The Light source URL exceeds its length limit.",
    );
  }
  return parsePublicHttpUrl(raw);
}

function redirectTarget(response: PublicHttpResponse, current: URL): URL {
  const raw = response.headers.location;
  const location = Array.isArray(raw) ? raw[0] : raw;
  if (!location) {
    throw new WebPluginError(
      "web_redirect_invalid",
      "The source redirect has no destination.",
    );
  }
  try {
    return parseLightUrl(new URL(location, current).toString());
  } catch {
    throw new WebPluginError(
      "web_redirect_invalid",
      "The source redirect has an invalid or non-public destination.",
    );
  }
}

function needsOriginCooldown(status: number): boolean {
  return status === 429 || status === 503;
}

function cooldownDuration(
  response: PublicHttpResponse,
  fallback: number,
): number {
  const raw = response.headers["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return fallback;
  const numeric = /^[0-9]+$/u.test(value)
    ? Number(value) * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(fallback, Math.min(86_400_000, numeric));
}

export function createLightTransport(params: {
  httpClient: PublicHttpClient;
  config: LightConfig;
}): Readonly<{ createSession(abortSignal?: AbortSignal): LightCrawlSession }> {
  const { config, httpClient } = params;
  const origins = new Set(
    config.sources.flatMap((source) => source.allowedOrigins),
  );
  const gate = createOriginGate(
    config.maxConcurrency,
    config.maxRequestsPerOrigin,
  );
  const robots = createRobotsPolicy(config, origins);
  const cooldowns = new Map<string, number>();

  const assertAdmittedOrigin = (url: URL) => {
    if (origins.has(url.origin)) return;
    throw new WebPluginError(
      "web_search_source_blocked",
      "The URL is outside the configured Light source origins.",
    );
  };

  const assertOriginReady = (origin: string) => {
    const until = cooldowns.get(origin);
    if (until === undefined) return;
    if (until > Date.now()) {
      throw new WebPluginError(
        "web_search_source_blocked",
        "The source is temporarily unavailable for Light crawling.",
      );
    }
    cooldowns.delete(origin);
  };

  return Object.freeze({
    createSession(abortSignal) {
      const budget = createSessionBudget(config, abortSignal);
      const fetchHop = async (url: URL): Promise<PublicHttpResponse> => {
        budget.assertActive();
        assertOriginReady(url.origin);
        return await gate.run(
          url.origin,
          budget.hardDeadline,
          budget.signal,
          async () => {
            budget.assertActive();
            assertOriginReady(url.origin);
            const maxBytes = budget.reserveRequest();
            let response: PublicHttpResponse;
            try {
              response = await httpClient.get({
                url: url.toString(),
                followRedirects: false,
                maxBytes,
                timeoutMs: Math.min(
                  config.requestTimeoutMs,
                  Math.max(1, budget.hardDeadline - Date.now()),
                ),
                abortSignal: budget.signal,
                headers: {
                  Accept:
                    "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml,text/xml,text/plain",
                  "Accept-Encoding": "gzip, deflate, br",
                },
              });
            } catch (error) {
              budget.completeRequest(maxBytes, maxBytes);
              budget.assertActive();
              throw error;
            }
            budget.completeRequest(response.bytesRead, maxBytes);
            budget.assertActive();
            if (needsOriginCooldown(response.status)) {
              if (cooldowns.size >= 512)
                cooldowns.delete(cooldowns.keys().next().value!);
              cooldowns.set(
                url.origin,
                Date.now() +
                  cooldownDuration(response, config.originCooldownMs),
              );
            }
            return response;
          },
        );
      };

      const fetchRobots = async (initial: URL): Promise<PublicHttpResponse> => {
        let current = initial;
        for (let redirects = 0; ; redirects += 1) {
          const response = await fetchHop(current);
          if (!REDIRECT_STATUSES.has(response.status)) return response;
          if (redirects >= config.maxRobotsRedirects) {
            throw new WebPluginError(
              "web_redirect_limit_exceeded",
              "The robots request exceeded its redirect limit.",
            );
          }
          current = redirectTarget(response, current);
        }
      };
      const policy = robots.createSession(fetchRobots, budget);

      const get = async (rawUrl: string): Promise<PublicHttpResponse> => {
        const initial = parseLightUrl(rawUrl);
        let current = initial;
        for (let redirects = 0; ; redirects += 1) {
          budget.assertActive();
          assertAdmittedOrigin(current);
          assertOriginReady(current.origin);
          // Robots checks run before transport permits are held, including after redirects.
          await policy.assertAllowed(current);
          const response = await fetchHop(current);
          if (!REDIRECT_STATUSES.has(response.status)) {
            return Object.freeze({
              ...response,
              requestedUrl: initial.toString(),
              finalUrl: current.toString(),
            });
          }
          if (redirects >= config.maxRedirects) {
            throw new WebPluginError(
              "web_redirect_limit_exceeded",
              "The Light source exceeded its redirect limit.",
            );
          }
          current = redirectTarget(response, current);
        }
      };

      return Object.freeze({
        get,
        canContinue: budget.canContinue,
        assertActive: budget.assertActive,
        consumeDecodedBytes: budget.consumeDecodedBytes,
        snapshot: budget.snapshot,
        sitemapsFor: policy.sitemapsFor,
        dispose: budget.dispose,
      });
    },
  });
}
