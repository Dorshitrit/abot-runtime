import type {
  ObservationMemoryReceipt,
  ObservationMemorySource,
} from "./observation-contracts.js";

function readRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  throw new Error("long_term_memory_observation_corrupt");
}
function readText(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error("long_term_memory_observation_corrupt");
}
function readTexts(value: unknown): readonly string[] {
  if (!Array.isArray(value))
    throw new Error("long_term_memory_observation_corrupt");
  return Object.freeze(value.map(readText));
}
function readTime(value: unknown): string {
  const text = readText(value);
  if (!Number.isFinite(Date.parse(text)))
    throw new Error("long_term_memory_observation_corrupt");
  return text;
}
export function parseObservationSource(
  value: unknown,
): ObservationMemorySource {
  const source = readRecord(value);
  if (source.kind !== "passive_observation")
    throw new Error("long_term_memory_observation_corrupt");
  if (source.certainty !== "observed" && source.certainty !== "inferred")
    throw new Error("long_term_memory_observation_corrupt");
  return Object.freeze({
    kind: "passive_observation",
    environmentId: readText(source.environmentId),
    deviceId: readText(source.deviceId),
    batchId: readText(source.batchId),
    observationIds: readTexts(source.observationIds),
    observedAt: readTime(source.observedAt),
    reason: readText(source.reason),
    certainty: source.certainty,
  });
}
export function parseObservationReceipts(
  value: unknown,
): readonly ObservationMemoryReceipt[] {
  if (!Array.isArray(value))
    throw new Error("long_term_memory_observation_corrupt");
  return Object.freeze(
    value.map((entry) => {
      const receipt = readRecord(entry);
      return Object.freeze({
        batchId: readText(receipt.batchId),
        recordIds: readTexts(receipt.recordIds),
        createdAt: readTime(receipt.createdAt),
        ...(receipt.expiresAt === undefined
          ? {}
          : { expiresAt: readTime(receipt.expiresAt) }),
      });
    }),
  );
}
export function parseObservationSources(
  value: unknown,
): readonly ObservationMemorySource[] {
  if (!Array.isArray(value))
    throw new Error("long_term_memory_observation_corrupt");
  return Object.freeze(value.map(parseObservationSource));
}
