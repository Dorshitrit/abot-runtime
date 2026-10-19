import { expect, test } from "vitest";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import type { CapabilityJsonObject } from "../orchestration/capability-adapters/result.js";
import type { WorkerSettledCapabilityResult } from "../orchestration/worker-capabilities/contracts.js";
import { projectPayloadSettledEvidence } from "../request/payload-settled-evidence.js";

function result(
  referenceData: string | undefined,
  payload: CapabilityJsonObject,
  executionId = "capability-execution-1",
): WorkerSettledCapabilityResult {
  return Object.freeze({
    executionId,
    callId: "call-1",
    invocationAttempt: 1,
    capabilityId: "example.observe",
    declaredEffect: "observation" as const,
    outcome: "succeeded" as const,
    observedEffect: "observation" as const,
    summary: "Observed the requested facts.",
    ...(referenceData === undefined ? {} : { referenceData }),
    adapterResult: Object.freeze({
      kind: "generic_capability_result_v1" as const,
      authority: "capability_adapter" as const,
      status: "executed" as const,
      ok: true,
      payload,
    }),
  });
}

const exactPayloads: CapabilityJsonObject[] = [
  { nested: { arbitraryField: "EXACT_REFERENCE\nwith spacing  " } },
  { arbitraryArray: [null, 4, { body: "EXACT_REFERENCE\nwith spacing  " }] },
];

test.each(exactPayloads)("sends an exact reference copy only once without rewriting the adapter", (payload) => {
  const original = result("EXACT_REFERENCE\nwith spacing  ", payload);
  const originalBytes = JSON.stringify(original);
  const adapterBytes = JSON.stringify(original.adapterResult);
  const projection = projectPayloadSettledEvidence([original]);

  expect(projection.deduplicatedReferenceDataCount).toBe(1);
  expect(projection.deduplicatedReferenceDataChars).toBe(original.referenceData!.length);
  expect(projection.results).toHaveLength(1);
  expect(projection.results[0]).not.toHaveProperty("referenceData");
  const projectedResult = projection.results[0]!;
  if (!("adapterResult" in projectedResult)) throw new Error("adapter_missing");
  expect(projectedResult.adapterResult).toBe(original.adapterResult);
  expect(JSON.stringify(projectedResult.adapterResult)).toBe(adapterBytes);
  expect(JSON.stringify(original)).toBe(originalBytes);
  expect(projection.resultSourceOverrides).toEqual([{
    sourceRef: `payload-result:${original.executionId}`,
    content: originalBytes,
    sourceFingerprint: hash(originalBytes),
  }]);
});

const distinctPayloads: CapabilityJsonObject[] = [
  { body: "prefix:EXACT_REFERENCE" },
  { body: "EXACT_REFERENCE:suffix" },
  { body: "EXACT_REFERENCE " },
  { body: "exact_reference" },
  { body: ["EXACT_", "REFERENCE"] },
  { body: { EXACT_REFERENCE: "another value" } },
];

test.each(distinctPayloads)("preserves reference data that has no exact string value match", (payload) => {
  const original = result("EXACT_REFERENCE", payload);
  const projection = projectPayloadSettledEvidence([original]);
  expect(projection.results).toEqual([original]);
  expect(projection.resultSourceOverrides).toEqual([]);
  expect(projection.deduplicatedReferenceDataCount).toBe(0);
  expect(projection.deduplicatedReferenceDataChars).toBe(0);
});

test("never uses a different execution as the replacement evidence", () => {
  const first = result("FIRST_REFERENCE", { content: "OTHER" });
  const second = result(undefined, { content: "FIRST_REFERENCE" }, "capability-execution-2");
  const projection = projectPayloadSettledEvidence([first, second]);
  expect(projection.results).toEqual([first, second]);
  expect(projection.resultSourceOverrides).toEqual([]);
  expect(projection.deduplicatedReferenceDataCount).toBe(0);
  expect(projection.deduplicatedReferenceDataChars).toBe(0);
});

test("does not alter adapter-internal duplicates, summary, references or ordering", () => {
  const first = Object.freeze({
    ...result("SAME", { first: "SAME", second: "SAME" }),
    summary: "SAME",
    references: [{ kind: "tool_target" as const, target: "exact-target" }],
  });
  const second = result("DISTINCT", { body: "OTHER" }, "capability-execution-2");
  const projection = projectPayloadSettledEvidence([first, second]);
  const { referenceData: _copy, ...expected } = first;
  expect(projection.results).toEqual([expected, second]);
  expect(projection.results[0]).toHaveProperty("adapterResult", first.adapterResult);
  expect(projection.resultSourceOverrides).toHaveLength(1);
  expect(projection.deduplicatedReferenceDataCount).toBe(1);
  expect(projection.deduplicatedReferenceDataChars).toBe(first.referenceData!.length);
});

test.each([undefined, "UNCOMPACTED_SUPPLEMENT"])("creates no source override for already compacted receipts: %s", (referenceData) => {
  const original = result("EXACT_REFERENCE", { content: "EXACT_REFERENCE" });
  const { adapterResult: _adapter, referenceData: _reference, ...receipt } = original;
  const compacted = Object.freeze({ ...receipt,
    ...(referenceData === undefined ? {} : { referenceData }),
    compactedSourceRef: "tool-result:capability-execution-1" });
  const projection = projectPayloadSettledEvidence([compacted]);
  expect(projection.results).toEqual([compacted]);
  expect(projection.resultSourceOverrides).toEqual([]);
  expect(projection.deduplicatedReferenceDataCount).toBe(0);
  expect(projection.deduplicatedReferenceDataChars).toBe(0);
});
