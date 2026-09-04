import { createHash } from "node:crypto";
import { WebPluginError } from "../errors.js";
import { parsePublicHttpUrl } from "../network-policy.js";
import {
  DEFAULT_LIGHT_SOURCES,
  LIGHT_SOURCE_SET_ID,
  LIGHT_SOURCE_SET_VERSION,
} from "./sources/catalog.js";
import type { LightSource } from "./sources/source-definition.js";

export type LightConfig = Readonly<{
  sourceSetId: string;
  sourceSetVersion: number;
  sources: readonly LightSource[];
  sourceLimit: number;
  maxCandidates: number;
  maxDepth: number;
  maxSitemaps: number;
  softTimeoutMs: number;
  hardTimeoutMs: number;
  maxRequests: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxConcurrency: number;
  maxRequestsPerOrigin: number;
  requestTimeoutMs: number;
  maxRedirects: number;
  maxRobotsRedirects: number;
  robotsTtlMs: number;
  originCooldownMs: number;
  cacheMaxDocuments: number;
  cacheMaxBytes: number;
  feedTtlMs: number;
  pageTtlMs: number;
}>;

const NUMBER_SETTINGS = {
  sourceLimit: [6, 1, 32],
  maxCandidates: [256, 1, 1_024],
  maxDepth: [2, 0, 3],
  maxSitemaps: [4, 0, 8],
  softTimeoutMs: [20_000, 1, 29_999],
  hardTimeoutMs: [30_000, 2, 30_000],
  maxRequests: [24, 1, 48],
  maxResponseBytes: [512 * 1_024, 512 * 1_024, 512 * 1_024],
  maxTotalBytes: [8 * 1_024 * 1_024, 512 * 1_024, 8 * 1_024 * 1_024],
  maxConcurrency: [3, 1, 3],
  maxRequestsPerOrigin: [1, 1, 1],
  requestTimeoutMs: [10_000, 1, 10_000],
  maxRedirects: [3, 0, 3],
  maxRobotsRedirects: [5, 5, 5],
  robotsTtlMs: [86_400_000, 0, 86_400_000],
  originCooldownMs: [60_000, 1_000, 300_000],
  cacheMaxDocuments: [500, 0, 500],
  cacheMaxBytes: [16 * 1_024 * 1_024, 0, 16 * 1_024 * 1_024],
  feedTtlMs: [300_000, 0, 300_000],
  pageTtlMs: [1_800_000, 0, 1_800_000],
} as const;

function invalidConfiguration(message: string): never {
  throw new WebPluginError("web_search_configuration_invalid", message);
}

function isConfigurationRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null) return false;
  if (Array.isArray(value)) return false;
  return typeof value === "object";
}

function readSourceStrings(
  value: unknown,
  name: string,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value))
    return invalidConfiguration(`Light ${name} must be an array.`);
  if (value.length === 0)
    return invalidConfiguration(`Light ${name} must not be empty.`);
  if (value.length > maximum)
    return invalidConfiguration(`Light ${name} has too many entries.`);
  return Object.freeze(
    value.map((entry) => {
      if (typeof entry !== "string")
        return invalidConfiguration(`Light ${name} entries must be strings.`);
      const text = entry.trim();
      if (!text)
        return invalidConfiguration(`Light ${name} entries must not be empty.`);
      if (text.length > 4_096)
        return invalidConfiguration(`Light ${name} entry is too long.`);
      return text;
    }),
  );
}

function readSourceText(value: unknown, name: string): string {
  if (typeof value !== "string")
    return invalidConfiguration(`Light source ${name} must be text.`);
  const text = value.trim();
  if (!text)
    return invalidConfiguration(`Light source ${name} must not be empty.`);
  if (text.length > 512)
    return invalidConfiguration(`Light source ${name} is too long.`);
  return text;
}

function readSource(value: unknown): LightSource {
  if (!isConfigurationRecord(value))
    return invalidConfiguration("Light source must be an object.");
  const allowedOrigins = readSourceStrings(
    value.allowedOrigins,
    "allowedOrigins",
    8,
  ).map((origin) => parsePublicHttpUrl(origin).origin);
  const entryUrls = readSourceStrings(value.entryUrls, "entryUrls", 8).map(
    (url) => parsePublicHttpUrl(url).toString(),
  );
  for (const url of entryUrls) {
    if (url.length > 1_024)
      return invalidConfiguration(
        "Light entry URLs must not exceed 1024 characters.",
      );
    if (!allowedOrigins.includes(new URL(url).origin)) {
      return invalidConfiguration(
        "Every Light entry URL must belong to that source's allowed origins.",
      );
    }
  }
  const id = readSourceText(value.id, "id");
  if (id.length > 64)
    return invalidConfiguration(
      "Light source IDs must not exceed 64 characters.",
    );
  return Object.freeze({
    id,
    title: readSourceText(value.title, "title"),
    description: readSourceText(value.description, "description"),
    keywords: readSourceStrings(value.keywords, "keywords", 64),
    languages: readSourceStrings(value.languages, "languages", 8),
    entryUrls: Object.freeze(entryUrls),
    allowedOrigins: Object.freeze(allowedOrigins),
  });
}

export function readLightConfig(value: unknown): LightConfig {
  const input = value === undefined ? {} : value;
  if (!isConfigurationRecord(input))
    return invalidConfiguration("Light settings must be an object.");
  const allowedKeys = new Set([...Object.keys(NUMBER_SETTINGS), "sources"]);
  for (const name of Object.keys(input)) {
    if (!allowedKeys.has(name))
      return invalidConfiguration(`Unknown Light setting: ${name}.`);
  }
  const numbers = {} as Record<keyof typeof NUMBER_SETTINGS, number>;
  for (const [name, [fallback, minimum, maximum]] of Object.entries(
    NUMBER_SETTINGS,
  )) {
    const candidate = input[name] ?? fallback;
    if (typeof candidate !== "number")
      return invalidConfiguration(`Light ${name} must be an integer.`);
    if (!Number.isSafeInteger(candidate))
      return invalidConfiguration(`Light ${name} must be an integer.`);
    if (candidate < minimum)
      return invalidConfiguration(`Light ${name} is below its minimum.`);
    if (candidate > maximum)
      return invalidConfiguration(`Light ${name} exceeds its maximum.`);
    numbers[name as keyof typeof NUMBER_SETTINGS] = candidate;
  }
  if (numbers.softTimeoutMs >= numbers.hardTimeoutMs) {
    return invalidConfiguration(
      "Light soft timeout must be shorter than its hard timeout.",
    );
  }
  const sourceInput = input.sources ?? DEFAULT_LIGHT_SOURCES;
  if (!Array.isArray(sourceInput))
    return invalidConfiguration("Light sources must be an array.");
  if (sourceInput.length === 0)
    return invalidConfiguration("Light sources must not be empty.");
  if (sourceInput.length > 64)
    return invalidConfiguration("Light supports at most 64 sources.");
  const sources = sourceInput.map(readSource);
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
    return invalidConfiguration("Light source IDs must be unique.");
  }
  const sourceSetId =
    sourceInput === DEFAULT_LIGHT_SOURCES
      ? LIGHT_SOURCE_SET_ID
      : `configured-${createHash("sha256").update(JSON.stringify(sources)).digest("hex").slice(0, 16)}`;
  return Object.freeze({
    ...numbers,
    sources: Object.freeze(sources),
    sourceSetId,
    sourceSetVersion: LIGHT_SOURCE_SET_VERSION,
  });
}
