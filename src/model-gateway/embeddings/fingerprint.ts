import { createHash } from "node:crypto";

import type { ResolvedEmbeddingProfile } from "../types.js";

/** Stable identity for vectors that may be compared with one another. */
export function createEmbeddingModelFingerprint(
  profile: ResolvedEmbeddingProfile,
  effectiveBaseUrl: string,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        providerId: profile.providerId,
        provider: profile.provider,
        baseUrl: normalizeBaseUrl(effectiveBaseUrl),
        model: profile.model,
        options: canonicalizeJson(profile.options),
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `${profile.provider}:${profile.model}:${digest}`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
