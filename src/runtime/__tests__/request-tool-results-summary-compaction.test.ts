import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { WorkerSettledCapabilityResult } from "../orchestration/worker-capabilities/contracts.js";
import { projectRequestToolResultsCheckpointMessage } from "../context/request-tool-results-checkpoint.js";
import {
  buildCompactedRequestToolResultsMessage,
  buildRequestToolResultsMessage,
} from "../context/request-tool-results.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/contracts.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import {
  compactedSourceFixture,
  settledSource,
} from "./support/compacted-execution-source-fixture.js";

const FULL_OUTPUT =
  "COVERED_OUTPUT_ALIAS:" + "exact source detail ".repeat(500);
type Projection = "checkpoint" | "legacy";

function fixture(summary = FULL_OUTPUT, generic = false) {
  const original = settledSource();
  if (original.adapterResult?.kind !== "registered_tool_execution_result_v1")
    throw new Error("expected_registered_result");
  const result: WorkerSettledCapabilityResult = {
    ...original,
    summary,
    adapterResult: generic
      ? {
          kind: "generic_capability_result_v1",
          authority: "capability_adapter",
          status: "executed",
          ok: true,
          payload: { output: FULL_OUTPUT },
        }
      : {
          ...original.adapterResult,
          result: { ...original.adapterResult.result, output: FULL_OUTPUT },
        },
  };
  const view = { sourceRevision: 7, results: [result] };
  const message = buildRequestToolResultsMessage(view);
  const content = JSON.stringify(JSON.parse(message.content).results[0]);
  const source: SemanticCompactionSource = {
    sourceRef: result.executionId,
    sourceFingerprint: hash(content),
    content,
  };
  const f = compactedSourceFixture([result], {}, [source]);
  const sources = new Map([[source.sourceRef, source]]);
  const project = (mode: Projection) =>
    mode === "legacy"
      ? buildCompactedRequestToolResultsMessage(view, f.checkpoint)
      : projectRequestToolResultsCheckpointMessage(
          message,
          f.checkpoint,
          sources,
        )!;
  return { ...f, source, sources, result, view, message, project };
}

function covered(message: ChatMessage) {
  return JSON.parse(message.content).semanticCheckpoint.coveredResults[0];
}

test.each(["checkpoint", "legacy"] as const)(
  "%s omits covered output aliases without changing canonical source bytes",
  (mode) => {
    const f = fixture();
    const before = JSON.stringify({
      result: f.result,
      source: f.source,
      checkpoint: f.checkpoint,
    });
    const projected = f.project(mode);
    expect(projected.content).not.toContain(FULL_OUTPUT);
    expect(covered(projected)).toMatchObject({
      executionId: f.result.executionId,
      callId: f.result.callId,
      outcome: f.result.outcome,
      observedEffect: f.result.observedEffect,
      sourceFingerprint: f.source.sourceFingerprint,
    });
    expect(covered(projected)).not.toHaveProperty("adapterResult");
    expect(covered(projected)).not.toHaveProperty("referenceData");
    expect(JSON.parse(projected.content).results).toEqual([]);
    expect(
      JSON.stringify({
        result: f.result,
        source: f.source,
        checkpoint: f.checkpoint,
      }),
    ).toBe(before);
  },
);

test.each(["checkpoint", "legacy"] as const)(
  "%s retains independent summaries and generic-adapter output",
  (mode) => {
    for (const summary of [
      "Independent outcome detail.",
      FULL_OUTPUT + " ",
      FULL_OUTPUT + "\n",
    ]) {
      const f = fixture(summary);
      expect(covered(f.project(mode)).summary).toBe(summary);
    }
    const generic = fixture(FULL_OUTPUT, true);
    expect(covered(generic.project(mode)).summary).toBe(FULL_OUTPUT);
  },
);

test("checkpoint alias proof comes from the exact source, not a projected adapter", () => {
  const f = fixture(FULL_OUTPUT, true);
  const packet = JSON.parse(f.message.content);
  packet.results[0].adapterResult = fixture().result.adapterResult;
  const projected = projectRequestToolResultsCheckpointMessage(
    { role: "user", content: JSON.stringify(packet) },
    f.checkpoint,
    f.sources,
  )!;
  expect(covered(projected).summary).toBe(FULL_OUTPUT);
});

test("previous covered receipts normalize from restored exact sources and remain idempotent", () => {
  const f = fixture();
  const packet = JSON.parse(f.project("checkpoint").content);
  packet.semanticCheckpoint.coveredResults[0].summary = FULL_OUTPUT;
  const previous: ChatMessage = {
    role: "user",
    content: JSON.stringify(packet),
  };
  const snapshot = JSON.parse(
    JSON.stringify(captureRequestContextCompaction(f.store)),
  );
  const restored = restoreRequestContextCompaction(snapshot);
  const checkpoint = restored.get(f.checkpoint.scopeId)!;
  const source = restored.materializeSource(
    f.source.sourceRef,
    f.source.sourceFingerprint,
  )!;
  const sources = new Map([[source.sourceRef, source]]);
  const projected = projectRequestToolResultsCheckpointMessage(
    previous,
    checkpoint,
    sources,
  )!;
  expect(projected.content).not.toContain(FULL_OUTPUT);
  expect(
    projectRequestToolResultsCheckpointMessage(projected, checkpoint, sources),
  ).toEqual(projected);
  expect(
    restored.materializeSource(source.sourceRef, source.sourceFingerprint),
  ).toEqual(f.source);
  expect(restored.get(checkpoint.scopeId)).toEqual(f.checkpoint);
});

test("prior receipts without matching canonical bytes keep their summary", () => {
  const f = fixture();
  const packet = JSON.parse(f.project("checkpoint").content);
  packet.semanticCheckpoint.coveredResults[0].summary = FULL_OUTPUT;
  const previous: ChatMessage = {
    role: "user",
    content: JSON.stringify(packet),
  };
  for (const sources of [
    new Map<string, SemanticCompactionSource>(),
    new Map([
      [f.source.sourceRef, { ...f.source, sourceFingerprint: hash("stale") }],
    ]),
  ]) {
    const projected = projectRequestToolResultsCheckpointMessage(
      previous,
      f.checkpoint,
      sources,
    )!;
    expect(covered(projected).summary).toBe(FULL_OUTPUT);
  }
});

test("checkpoint projection leaves uncovered results unchanged", () => {
  const f = fixture();
  const checkpoint = { ...f.checkpoint, sourceDigests: [] };
  const projected = projectRequestToolResultsCheckpointMessage(
    f.message,
    checkpoint,
    f.sources,
  )!;
  expect(JSON.parse(projected.content).results).toEqual(
    JSON.parse(f.message.content).results,
  );
  expect(
    JSON.parse(projected.content).semanticCheckpoint.coveredResults,
  ).toEqual([]);
});

test.each(["checkpoint", "legacy"] as const)(
  "%s still rejects a mismatched covered source before returning a projection",
  (mode) => {
    const f = fixture();
    const checkpoint = {
      ...f.checkpoint,
      sourceDigests: f.checkpoint.sourceDigests.map((source) => ({
        ...source,
        sourceFingerprint: hash("different source"),
      })),
    };
    expect(() =>
      mode === "legacy"
        ? buildCompactedRequestToolResultsMessage(f.view, checkpoint)
        : projectRequestToolResultsCheckpointMessage(
            f.message,
            checkpoint,
            f.sources,
          ),
    ).toThrow(
      mode === "legacy"
        ? "request_tool_results_compaction_fingerprint_mismatch"
        : "context_compaction_source_identity_conflict",
    );
  },
);
