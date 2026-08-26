import { createHash } from "node:crypto";

import type {
  ModelProviderInputTokenCount,
  ModelProviderInputTokenMeasurement,
} from "../providers/contracts.js";
import type { ModelGatewayRequest, ResolvedModelInvocation } from "../types.js";

const DEFAULT_MEASUREMENT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MEASUREMENT_LIMIT = 128;

type MeasurementBinding = Readonly<{
  requestBody: ModelGatewayRequest;
  invocation: ResolvedModelInvocation;
}>;

type MeasurementEntry = Readonly<{
  expiresAt: number;
  measurement: ModelProviderInputTokenMeasurement;
}>;

export type InputTokenMeasurementStore = Readonly<{
  record(
    binding: MeasurementBinding,
    result: ModelProviderInputTokenCount,
  ): void;
  resolve(
    binding: MeasurementBinding,
  ): ModelProviderInputTokenMeasurement | undefined;
}>;

export function createInputTokenMeasurementStore(options: {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
} = {}): InputTokenMeasurementStore {
  const entries = new Map<string, MeasurementEntry>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_MEASUREMENT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MEASUREMENT_LIMIT;

  return Object.freeze({
    record(binding, result) {
      removeExpiredEntries(entries, now());
      const key = createMeasurementKey(binding);
      entries.delete(key);
      entries.set(key, {
        expiresAt: now() + ttlMs,
        measurement: Object.freeze({
          inputTokens: result.inputTokens,
          providerEnvelopeFingerprint: result.providerEnvelopeFingerprint,
          source: "provider_input_token_count" as const,
        }),
      });
      removeOldestEntries(entries, maxEntries);
    },
    resolve(binding) {
      removeExpiredEntries(entries, now());
      return entries.get(createMeasurementKey(binding))?.measurement;
    },
  });
}

function createMeasurementKey(binding: MeasurementBinding): string {
  const invocation = binding.invocation;
  return createHash("sha256")
    .update(
      JSON.stringify({
        requestBody: binding.requestBody,
        profileId: invocation.profile.id,
        providerId: invocation.profile.providerId,
        provider: invocation.profile.provider,
        model: invocation.model,
        contextWindowTokens: invocation.profile.contextWindowTokens,
      }),
    )
    .digest("hex");
}

function removeExpiredEntries(
  entries: Map<string, MeasurementEntry>,
  currentTime: number,
): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= currentTime) {
      entries.delete(key);
    }
  }
}

function removeOldestEntries(
  entries: Map<string, MeasurementEntry>,
  maxEntries: number,
): void {
  while (entries.size > maxEntries) {
    const oldestKey = entries.keys().next().value;
    if (typeof oldestKey !== "string") {
      return;
    }
    entries.delete(oldestKey);
  }
}
