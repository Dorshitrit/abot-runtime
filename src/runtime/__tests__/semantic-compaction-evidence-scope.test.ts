import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  generateSemanticCompactionCandidateBatched,
} from "../context/semantic-compaction/index.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "../context/semantic-compaction/evidence-scope.js";
import {
  compactContinuation,
  readCompactionEnvelope,
  semanticContractFixture,
} from "./support/semantic-compaction-contract-fixture.js";

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test.each([false, true])(
    `G04/A01: ${policy} counts and generates scoped keyed batches/slices (%s)`,
    async (sliced) => {
      const fixture = semanticContractFixture({ policy, sliced });
      const candidate = await generateSemanticCompactionCandidateBatched(
        fixture.params,
      );
      expect(candidate.sourceDigests).toHaveLength(1);
      for (const messages of [...fixture.counted, ...fixture.captured]) {
        const envelope = readCompactionEnvelope(messages);
        expect(envelope).toHaveProperty(
          "evidenceScope",
          SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
        );
        if (envelope.kind === "runtime_semantic_compaction_checkpoint_v2")
          continue;
        expect(envelope).toHaveProperty(
          "currentRequest",
          fixture.params.request.prompt,
        );
        const sources = envelope.sourceSlice
          ? [envelope.sourceSlice]
          : envelope.newSources!;
        expect(sources.map(({ sourceKey }) => sourceKey)).toEqual(["source_0"]);
        expect(sources[0]!.sourceRef).toBe(fixture.source.sourceRef);
        expect(envelope).not.toHaveProperty("historyMessages");
        expect(envelope).not.toHaveProperty("capabilityCatalog");
      }
      if (sliced) {
        expect(fixture.captured.length).toBeGreaterThan(1);
        expect(
          fixture.captured
            .map(readCompactionEnvelope)
            .map(({ sourceSlice }) => sourceSlice!.content)
            .join(""),
        ).toBe(fixture.source.content);
      }
      // Neither invocation-local slots nor interpretation metadata become stored authority.
      expect(candidate).not.toHaveProperty("evidenceScope");
      expect(candidate.sourceDigests[0]).not.toHaveProperty("sourceKey");
    },
  );
}

test("G05/G06: legacy v2 snapshot bytes and source prefix survive keyed replacement", async () => {
  const fixture = semanticContractFixture();
  const oldSource = {
    sourceRef: "legacy-source",
    content: "Original failed target observation.",
  };
  const sourceFingerprint = hash(oldSource.content);
  const oldCheckpoint = {
    ...fixture.params.binding,
    kind: "runtime_semantic_compaction_checkpoint_v2" as const,
    scopeId: fixture.params.scopeId,
    sourceRevision: 0,
    continuation: compactContinuation({
      failedApproaches: [oldSource.content],
    }),
    sourceDigests: [
      {
        sourceRef: oldSource.sourceRef,
        sourceFingerprint,
        digest: oldSource.content,
      },
    ],
  };
  fixture.store.registerSources([{ ...oldSource, sourceFingerprint }]);
  fixture.store.commit(oldCheckpoint);
  const snapshot = captureRequestContextCompaction(fixture.store);
  const serialized = JSON.stringify(snapshot);
  const restored = restoreRequestContextCompaction(JSON.parse(serialized));
  expect(JSON.stringify(captureRequestContextCompaction(restored))).toBe(
    serialized,
  );
  const candidate = await generateSemanticCompactionCandidateBatched({
    ...fixture.params,
    previous: restored.get(fixture.params.scopeId),
  });
  expect(candidate.sourceDigests[0]).toEqual(oldCheckpoint.sourceDigests[0]);
  expect(candidate.sourceDigests[1]).toMatchObject({
    sourceRef: fixture.source.sourceRef,
    sourceFingerprint: fixture.source.sourceFingerprint,
  });
  expect(restored.get(fixture.params.scopeId)).toEqual(oldCheckpoint);
  expect(candidate.kind).toBe("runtime_semantic_compaction_checkpoint_v2");
});

test("G04/G07: adaptive batches retain cumulative slots and count the matching keyed schema", async () => {
  const fixture = semanticContractFixture({ maxSourcesPerBatch: 2 });
  const sources = ["source-a", "source-b", "source-c"].map((sourceRef) => {
    const content = `Exact observed fact from ${sourceRef}.`;
    return { sourceRef, sourceFingerprint: hash(content), content };
  });
  const candidate = await generateSemanticCompactionCandidateBatched({
    ...fixture.params,
    sources,
  });
  const batches = fixture.captured.map(readCompactionEnvelope);
  expect(
    batches.map(({ newSources }) =>
      newSources!.map(({ sourceKey, sourceRef }) => ({ sourceKey, sourceRef })),
    ),
  ).toEqual([
    [
      { sourceKey: "source_0", sourceRef: "source-a" },
      { sourceKey: "source_1", sourceRef: "source-b" },
    ],
    [{ sourceKey: "source_2", sourceRef: "source-c" }],
  ]);
  expect(candidate.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual(
    sources.map(({ sourceRef }) => sourceRef),
  );
  for (const [countInput] of fixture.countInputTokens.mock.calls) {
    const envelope = readCompactionEnvelope(
      countInput.messages as ChatMessage[],
    );
    if (envelope.kind === "runtime_semantic_compaction_checkpoint_v2") {
      expect(countInput.format).toEqual({ type: "text" });
      continue;
    }
    const keys = [
      ...(envelope.previousSourceDigests ?? []),
      ...envelope.newSources!,
    ].map(({ sourceKey }) => sourceKey);
    expect(countInput.format).toMatchObject({
      schema: {
        properties: {
          sourceDigests: {
            type: "object",
            required: keys,
            additionalProperties: false,
          },
        },
      },
    });
    expect(envelope).toHaveProperty(
      "evidenceScope",
      SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
    );
  }
});
