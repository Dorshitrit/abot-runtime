import { expect, test } from "vitest";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  generateSemanticCompactionCandidate,
  generateSemanticCompactionCandidateBatched,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/index.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import {
  compactContinuation,
  semanticContractFixture,
} from "./support/semantic-compaction-contract-fixture.js";

function rollingCheckpointFixture() {
  const fixture = semanticContractFixture();
  const source = {
    sourceRef: "earlier-source",
    content: "Original immutable evidence.",
  };
  const original = { ...source, sourceFingerprint: hash(source.content) };
  const previous: SemanticCompactionCheckpoint = {
    ...fixture.params.binding,
    kind: "runtime_semantic_compaction_checkpoint_v2",
    scopeId: fixture.params.scopeId,
    sourceRevision: 1,
    sourceDigests: [
      {
        sourceRef: original.sourceRef,
        sourceFingerprint: original.sourceFingerprint,
        digest: "Earlier evidence summary.",
      },
    ],
    continuation: compactContinuation(),
  };
  fixture.store.registerSources([original]);
  fixture.store.commit(previous);
  return { ...fixture, original, previous };
}

test("rolling generation may rewrite prior digests but cannot drop or relabel their identities", async () => {
  const fixture = rollingCheckpointFixture();
  const rewritten = "Preserved earlier detail א😀 ".repeat(400).trim();
  fixture.invoke.mockResolvedValue({
    text: JSON.stringify({
      continuation: compactContinuation(),
      sourceDigests: {
        source_1: "Fresh evidence detail.",
        source_0: rewritten,
      },
    }),
    meta: {},
  });
  const candidate = await generateSemanticCompactionCandidate({
    ...fixture.params,
    sourceRevision: 2,
    previous: fixture.previous,
  });
  expect(candidate.sourceDigests).toEqual([
    { ...fixture.previous.sourceDigests[0], digest: rewritten },
    {
      sourceRef: fixture.source.sourceRef,
      sourceFingerprint: fixture.source.sourceFingerprint,
      digest: "Fresh evidence detail.",
    },
  ]);
  expect(fixture.store.get(candidate.scopeId)).toEqual(fixture.previous);
  fixture.store.commit(candidate);
  const snapshot = JSON.parse(
    JSON.stringify(captureRequestContextCompaction(fixture.store)),
  );
  const restored = restoreRequestContextCompaction(snapshot);
  expect(restored.get(candidate.scopeId)).toEqual(candidate);
  expect(
    restored.materializeSource(
      fixture.original.sourceRef,
      fixture.original.sourceFingerprint,
    ),
  ).toEqual(fixture.original);
  expect(
    restored.materializeSource(
      fixture.source.sourceRef,
      fixture.source.sourceFingerprint,
    ),
  ).toEqual(fixture.source);
});

test.each([
  "missing",
  "reordered",
  "different-fingerprint",
  "stale-revision",
  "different-call",
] as const)("store rejects %s replacements atomically", (change) => {
  const fixture = rollingCheckpointFixture();
  const first = fixture.previous.sourceDigests[0]!;
  const second = {
    sourceRef: fixture.source.sourceRef,
    sourceFingerprint: fixture.source.sourceFingerprint,
    digest: "New digest.",
  };
  const replacements = {
    missing: { sourceDigests: [second] },
    reordered: { sourceDigests: [second, first] },
    "different-fingerprint": {
      sourceDigests: [{ ...first, sourceFingerprint: hash("changed") }, second],
    },
    "stale-revision": { sourceRevision: 0 },
    "different-call": { callId: "another-call" },
  };
  const candidate = {
    ...fixture.previous,
    sourceRevision: 2,
    sourceDigests: [first, second],
    ...replacements[change],
  };
  const before = captureRequestContextCompaction(fixture.store);
  expect(() => fixture.store.commit(candidate)).toThrow(
    "context_compaction_checkpoint_regression",
  );
  expect(captureRequestContextCompaction(fixture.store)).toEqual(before);
});

test("each new batch receives only the most recent replacement digests with unique slots", async () => {
  const fixture = semanticContractFixture({
    maxSourcesPerBatch: 1,
    output: (attempt) =>
      JSON.stringify({
        continuation: compactContinuation({ currentState: `state-${attempt}` }),
        sourceDigests: Object.fromEntries(
          Array.from({ length: attempt }, (_, index) => [
            `source_${index}`,
            `replacement-${attempt}-source-${index}`,
          ]),
        ),
      }),
  });
  const sources = ["alpha", "beta", "gamma"].map((sourceRef) => ({
    sourceRef,
    content: sourceRef,
    sourceFingerprint: hash(sourceRef),
  }));
  const candidate = await generateSemanticCompactionCandidateBatched({
    ...fixture.params,
    sources,
  });
  const envelopes = fixture.captured.map((messages) =>
    JSON.parse(messages.at(-1)!.content),
  );
  expect(envelopes[0]).not.toHaveProperty("previousSourceDigests");
  expect(
    envelopes.map(({ newSources }) =>
      newSources.map(({ sourceKey }: { sourceKey: string }) => sourceKey),
    ),
  ).toEqual([["source_0"], ["source_1"], ["source_2"]]);
  expect(
    envelopes[1].previousSourceDigests.map(
      ({ sourceKey, digest }: { sourceKey: string; digest: string }) => ({
        sourceKey,
        digest,
      }),
    ),
  ).toEqual([{ sourceKey: "source_0", digest: "replacement-1-source-0" }]);
  expect(
    envelopes[2].previousSourceDigests.map(
      ({ sourceKey, digest }: { sourceKey: string; digest: string }) => ({
        sourceKey,
        digest,
      }),
    ),
  ).toEqual([
    { sourceKey: "source_0", digest: "replacement-2-source-0" },
    { sourceKey: "source_1", digest: "replacement-2-source-1" },
  ]);
  expect(candidate.sourceDigests).toEqual(
    sources.map(({ sourceRef, sourceFingerprint }, index) => ({
      sourceRef,
      sourceFingerprint,
      digest: `replacement-3-source-${index}`,
    })),
  );
  expect(fixture.store.get(candidate.scopeId)).toBeUndefined();
});

test.each([
  "other-scope",
  "other-request",
  "newer-revision",
  "overlapping-source",
] as const)(
  "generation rejects an inapplicable prior checkpoint: %s",
  async (change) => {
    const fixture = rollingCheckpointFixture();
    const mutations = {
      "other-scope": { scopeId: "other-scope" },
      "other-request": { requestId: "other-request" },
      "newer-revision": { sourceRevision: 3 },
      "overlapping-source": {
        sourceDigests: [
          {
            sourceRef: fixture.source.sourceRef,
            sourceFingerprint: fixture.source.sourceFingerprint,
            digest: "Already covered.",
          },
        ],
      },
    };
    await expect(
      generateSemanticCompactionCandidate({
        ...fixture.params,
        sourceRevision: 2,
        previous: { ...fixture.previous, ...mutations[change] },
      }),
    ).rejects.toThrow("context_compaction_checkpoint_not_applicable");
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.countInputTokens).not.toHaveBeenCalled();
    expect(fixture.store.get(fixture.params.scopeId)).toEqual(fixture.previous);
  },
);
