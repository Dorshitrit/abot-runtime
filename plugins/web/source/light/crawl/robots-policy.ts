import { isWebPluginError, WebPluginError } from "../../errors.js";
import { parsePublicHttpUrl } from "../../network-policy.js";
import { WEB_LIMITS } from "../../limits.js";
import type { PublicHttpResponse } from "../../public-http.js";
import type { LightConfig } from "../config.js";
import { decodeLightResponse } from "../documents/response-decoding.js";
import { httpCacheFreshnessMs } from "../documents/http-cache-freshness.js";
import {
  isRobotsPathAllowed,
  parseRobotsDocument,
  type RobotsDocument,
} from "./robots-parser.js";
import type { LightSessionBudget } from "./session-budget.js";
import { createRobotsCache } from "./robots-cache.js";

type RobotsFetch = (url: URL) => Promise<PublicHttpResponse>;
const BLOCKED_DOCUMENT: RobotsDocument = Object.freeze({
  rules: Object.freeze([{ path: "/", allow: false }]),
  sitemaps: Object.freeze([]),
});
const EMPTY_DOCUMENT: RobotsDocument = Object.freeze({
  rules: Object.freeze([]),
  sitemaps: Object.freeze([]),
});

function shouldStopAfterRobotsFailure(error: unknown): boolean {
  if (!isWebPluginError(error)) return false;
  if (error.code === "web_request_aborted") return true;
  return error.code === "web_search_budget_exhausted";
}

function hasUnavailableRobots(status: number): boolean {
  return status === 404 || status === 410;
}

function hasIncompleteRobots(response: PublicHttpResponse): boolean {
  if (response.status === 206) return true;
  if (response.headers["content-range"] !== undefined) return true;
  return response.partialContent;
}

function hasSuccessfulRobots(status: number): boolean {
  if (status < 200) return false;
  return status < 300;
}

function readRobotsResponse(
  response: PublicHttpResponse,
  config: LightConfig,
  budget: LightSessionBudget,
): Readonly<{ document: RobotsDocument; ttl: number }> {
  if (hasIncompleteRobots(response)) {
    return { document: BLOCKED_DOCUMENT, ttl: config.originCooldownMs };
  }
  if (hasUnavailableRobots(response.status)) {
    return {
      document: EMPTY_DOCUMENT,
      ttl: httpCacheFreshnessMs(response, config.robotsTtlMs, Date.now()),
    };
  }
  if (!hasSuccessfulRobots(response.status)) {
    return { document: BLOCKED_DOCUMENT, ttl: config.originCooldownMs };
  }
  const remainingBytes = config.maxTotalBytes - budget.snapshot().decodedBytes;
  if (remainingBytes <= 0) {
    throw new WebPluginError(
      "web_search_budget_exhausted",
      "The Light decoded byte budget was exhausted.",
    );
  }
  const decoded = decodeLightResponse(
    response,
    Math.min(config.maxResponseBytes, remainingBytes),
    budget.consumeDecodedBytes,
  );
  if (decoded.partialContent) {
    return { document: BLOCKED_DOCUMENT, ttl: config.originCooldownMs };
  }
  const document = parseRobotsDocument(
    new TextDecoder("utf-8").decode(decoded.body),
  );
  const ttl = httpCacheFreshnessMs(response, config.robotsTtlMs, Date.now());
  return { document, ttl };
}

export function createRobotsPolicy(
  config: LightConfig,
  admittedOrigins: ReadonlySet<string>,
) {
  // Only configured origins own cache entries; redirected robots hosts never gain admission.
  const completed = createRobotsCache();

  const load = async (
    origin: string,
    fetch: RobotsFetch,
    budget: LightSessionBudget,
  ): Promise<RobotsDocument> => {
    const cached = completed.get(origin);
    if (cached) return cached;
    let document = BLOCKED_DOCUMENT;
    let ttl = config.originCooldownMs;
    try {
      const response = await fetch(new URL("/robots.txt", origin));
      budget.assertActive();
      const interpreted = readRobotsResponse(response, config, budget);
      document = interpreted.document;
      ttl = interpreted.ttl;
    } catch (error) {
      budget.assertActive();
      if (shouldStopAfterRobotsFailure(error)) throw error;
    }
    completed.set(origin, document, ttl);
    return document;
  };

  return Object.freeze({
    createSession(fetch: RobotsFetch, budget: LightSessionBudget) {
      const documents = new Map<string, Promise<RobotsDocument>>();
      const observed = new Map<string, RobotsDocument>();
      return Object.freeze({
        async assertAllowed(url: URL) {
          let pending = documents.get(url.origin);
          if (!pending) {
            pending = load(url.origin, fetch, budget);
            documents.set(url.origin, pending);
          }
          const document = await pending;
          observed.set(url.origin, document);
          budget.assertActive();
          if (!isRobotsPathAllowed(document, url)) {
            throw new WebPluginError(
              "web_search_source_blocked",
              "The source robots policy does not allow this Light crawl.",
            );
          }
        },
        sitemapsFor(origin: string): readonly string[] {
          const document = observed.get(origin) ?? completed.get(origin);
          if (!document) return Object.freeze([]);
          return Object.freeze(
            document.sitemaps.filter((rawUrl) => {
              if (rawUrl.length > WEB_LIMITS.upstreamUrlChars) return false;
              try {
                return admittedOrigins.has(parsePublicHttpUrl(rawUrl).origin);
              } catch {
                return false;
              }
            }),
          );
        },
      });
    },
  });
}
