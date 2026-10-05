import { expect, test } from "vitest";
import { createSemanticCompactionFormat } from "../context/semantic-compaction/format.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  generateSemanticCompactionCandidateBatched,
} from "../context/semantic-compaction/index.js";
import {
  compactContinuation,
  readCompactionEnvelope,
  semanticContractFixture,
} from "./support/semantic-compaction-contract-fixture.js";

const CURRENT_OBJECT_PROPERTY_LIMIT = 5000;
const MAX_SOURCE_SLOTS = 4988;

function sources(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    sourceRef: `source-${index}`,
    sourceFingerprint: hash("x"),
    content: "x",
  }));
}

function objectPropertyCount(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  return (
    (properties && typeof properties === "object"
      ? Object.keys(properties).length
      : 0) +
    Object.values(record).reduce<number>(
      (total, entry) => total + objectPropertyCount(entry),
      0,
    )
  );
}

test("P1: current 5000-property boundary permits 4988 sources and rejects 4989", () => {
  const valid = createSemanticCompactionFormat(sources(MAX_SOURCE_SLOTS), 1);
  expect(objectPropertyCount(valid.schema)).toBe(CURRENT_OBJECT_PROPERTY_LIMIT);
  expect(() =>
    createSemanticCompactionFormat(sources(MAX_SOURCE_SLOTS + 1), 1),
  ).toThrow("context_compaction_source_count_exceeds_schema_limit");
});

test("P1: rolling batches preserve all earlier source slots within the total schema capacity", async () => {
  const fixture = semanticContractFixture({
    maxSourcesPerBatch: 44,
    output: (_attempt, messages) => {
      const envelope = JSON.parse(messages.at(-1)!.content) as {
        previousSourceDigests?: readonly { sourceKey: string }[];
        newSources: readonly { sourceKey: string }[];
      };
      return JSON.stringify({
        continuation: compactContinuation(),
        sourceDigests: Object.fromEntries(
          [
            ...(envelope.previousSourceDigests ?? []),
            ...envelope.newSources,
          ].map(({ sourceKey }) => [sourceKey, "Observed evidence."]),
        ),
      });
    },
  });
  const originals = sources(89);
  const candidate = await generateSemanticCompactionCandidateBatched({
    ...fixture.params,
    sources: originals,
  });
  const batches = fixture.captured.map(readCompactionEnvelope);
  expect(batches.map(({ newSources }) => newSources!.length)).toEqual([
    44, 44, 1,
  ]);
  expect(
    batches.flatMap(({ newSources }) =>
      newSources!.map(({ sourceRef }) => sourceRef),
    ),
  ).toEqual(originals.map(({ sourceRef }) => sourceRef));
  expect(candidate.sourceDigests).toEqual(
    originals.map(({ sourceRef, sourceFingerprint }) => ({
      sourceRef,
      sourceFingerprint,
      digest: "Observed evidence.",
    })),
  );
  expect(
    fixture.invoke.mock.calls.map(([input]) =>
      objectPropertyCount((input.format as { schema: unknown }).schema),
    ),
  ).toEqual([56, 100, 101]);
});

test("P1: one generation accepts the full source slot boundary without truncating identities", async () => {
  const fixture = semanticContractFixture({
    contextWindowTokens: 1_000_000,
    output: (_attempt, messages) => {
      const envelope = readCompactionEnvelope(messages);
      return JSON.stringify({
        continuation: compactContinuation(),
        sourceDigests: Object.fromEntries(
          envelope.newSources!.map(({ sourceKey }) => [sourceKey, "x"]),
        ),
      });
    },
  });
  const originals = sources(MAX_SOURCE_SLOTS);
  const candidate = await generateSemanticCompactionCandidateBatched({
    ...fixture.params,
    sources: originals,
  });
  expect(
    candidate.sourceDigests.map(({ sourceRef, sourceFingerprint }) => ({
      sourceRef,
      sourceFingerprint,
    })),
  ).toEqual(
    originals.map(({ sourceRef, sourceFingerprint }) => ({
      sourceRef,
      sourceFingerprint,
    })),
  );
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
});
