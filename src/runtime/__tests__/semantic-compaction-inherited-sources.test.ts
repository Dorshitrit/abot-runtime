import { expect, test } from "vitest";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  generateSemanticCompactionCandidate,
  generateSemanticCompactionCandidateBatched,
  type SemanticCompactionGenerationParams,
} from "../context/semantic-compaction/index.js";
import { prepareReplacementCompactionBudget } from "../context/semantic-compaction/replacement-budget.js";
import { parseSemanticCompactionOutput } from "../context/semantic-compaction/parser.js";
import {
  compactContinuation,
  readCompactionEnvelope,
} from "./support/semantic-compaction-contract-fixture.js";
import { inheritedCompactionFixture } from "./support/semantic-compaction-inheritance-fixture.js";

test.each([false, true])(
  "inherits exact source evidence without the old continuation (sliced=%s)",
  async (sliced) => {
    const f = inheritedCompactionFixture({ sliced });
    const before = f.store.get(f.previous.scopeId);
    const candidate = await generateSemanticCompactionCandidateBatched(f.params);
    const envelopes = f.captured.map((messages) =>
      JSON.parse(messages.at(-1)!.content),
    );
    const first = envelopes[0];
    const expected = [{ ...f.digest, sourceKey: "source_0" }];
    if (sliced) {
      expect(first.previousCheckpoint).toEqual({ sourceDigests: expected });
      expect(first.sourceSlice.sourceKey).toBe("source_1");
      expect(envelopes.length).toBeGreaterThan(1);
      expect(envelopes[1]).not.toHaveProperty("previousCheckpoint");
      expect(envelopes[1].partialSourceFold.sourceDigests).toHaveLength(2);
    } else {
      expect(first.previousSourceDigests).toEqual(expected);
      expect(first.newSources[0].sourceKey).toBe("source_1");
    }
    expect(first).not.toHaveProperty("previousContinuation");
    expect(JSON.stringify(f.captured)).not.toContain("OLD_OBJECTIVE");
    expect(JSON.stringify(f.captured)).not.toContain(f.original.content);
    expect(candidate).not.toHaveProperty("inheritedSourceDigests");
    expect(candidate.sourceDigests.map(({ sourceRef, sourceFingerprint }) => ({
      sourceRef, sourceFingerprint,
    }))).toEqual([f.original, f.source].map(({ sourceRef, sourceFingerprint }) => ({
      sourceRef, sourceFingerprint,
    })));
    expect(candidate.objectiveFingerprint).toBe(f.params.binding.objectiveFingerprint);
    expect(candidate.scopeId).toBe(f.params.scopeId);
    expect(f.store.get(f.previous.scopeId)).toBe(before);
    expect(f.store.get(candidate.scopeId)).toBeUndefined();
    expect(f.store.materializeSource(
      f.original.sourceRef, f.original.sourceFingerprint,
    )).toEqual(f.original);
  },
);

test("inherited identities share the unchanged replacement token budget and exact output coverage", () => {
  const f = inheritedCompactionFixture();
  const inheritedBudget = prepareReplacementCompactionBudget(f.params);
  const ordinaryBudget = prepareReplacementCompactionBudget({
    ...f.params, inheritedSourceDigests: undefined,
  });
  expect(inheritedBudget.checkpointTokenAllowance).toBe(ordinaryBudget.checkpointTokenAllowance);
  expect(inheritedBudget.expectedSources).toEqual(
    [f.original, f.source].map(({ sourceRef, sourceFingerprint }) => ({
      sourceRef, sourceFingerprint,
    })),
  );
  const missingInherited = parseSemanticCompactionOutput(JSON.stringify({
    continuation: compactContinuation(),
    sourceDigests: { source_1: "Only the new source." },
  }), inheritedBudget.expectedSources);
  expect(missingInherited.ok).toBe(false);
});

test("later batches replace inheritance with the real new-objective candidate", async () => {
  const f = inheritedCompactionFixture({
    maxSourcesPerBatch: 1,
    output: (attempt) => JSON.stringify({
      continuation: compactContinuation({ currentState: "new-state-" + attempt }),
      sourceDigests: Object.fromEntries(
        Array.from({ length: attempt + 1 }, (_, index) => [
          "source_" + index, "replacement-" + attempt + "-" + index,
        ]),
      ),
    }),
  });
  const sources = ["new-one", "new-two"].map((sourceRef) => ({
    sourceRef, content: sourceRef, sourceFingerprint: hash(sourceRef),
  }));
  const candidate = await generateSemanticCompactionCandidateBatched({
    ...f.params, sources,
  });
  const envelopes = f.captured.map(readCompactionEnvelope);
  expect(envelopes).toHaveLength(2);
  expect(envelopes[0]?.previousContinuation).toBeUndefined();
  expect(envelopes[1]?.previousContinuation?.currentState).toBe("new-state-1");
  expect(envelopes[1]?.previousSourceDigests?.map(({ digest }) => digest)).toEqual([
    "replacement-1-0", "replacement-1-1",
  ]);
  expect(envelopes.map(({ newSources }) => newSources?.[0]?.sourceKey)).toEqual([
    "source_1", "source_2",
  ]);
  expect(candidate.sourceDigests).toHaveLength(3);
  expect(f.store.get(f.previous.scopeId)).toEqual(f.previous);
});

test.each([
  "previous", "super-consumer", "mixed-consumers", "empty-consumers",
  "bad-revision", "missing-source", "changed-fingerprint", "duplicate",
  "new-source-overlap", "empty-digest", "empty-inheritance",
] as const)("rejects invalid inherited evidence before any count or generation: %s", async (change) => {
  const f = inheritedCompactionFixture();
  const variants: Record<typeof change, Partial<SemanticCompactionGenerationParams>> = {
    previous: { previous: f.previous },
    "super-consumer": { binding: { ...f.params.binding, allowedConsumers: ["worker.decision"] } },
    "mixed-consumers": { binding: {
      ...f.params.binding, allowedConsumers: ["execution.decision", "supervisor.decision"],
    } },
    "empty-consumers": { binding: { ...f.params.binding, allowedConsumers: [] } },
    "bad-revision": { sourceRevision: -1 },
    "missing-source": { inheritedSourceDigests: [{ ...f.digest, sourceRef: "missing" }] },
    "changed-fingerprint": { inheritedSourceDigests: [{
      ...f.digest, sourceFingerprint: hash("different source"),
    }] },
    duplicate: { inheritedSourceDigests: [f.digest, f.digest] },
    "new-source-overlap": { sources: [f.original] },
    "empty-digest": { inheritedSourceDigests: [{ ...f.digest, digest: "" }] },
    "empty-inheritance": { inheritedSourceDigests: [] },
  };
  const before = f.store.snapshot!();
  await expect(generateSemanticCompactionCandidateBatched({
    ...f.params, ...variants[change],
  })).rejects.toThrow("context_compaction_");
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.countInputTokens).not.toHaveBeenCalled();
  expect(f.store.snapshot!()).toEqual(before);
});

test("direct generation also rejects an inherited source before provider admission", async () => {
  const f = inheritedCompactionFixture();
  await expect(generateSemanticCompactionCandidate({
    ...f.params,
    inheritedSourceDigests: [{ ...f.digest, sourceFingerprint: hash("mismatch") }],
  })).rejects.toThrow("context_compaction_inheritance_source_missing");
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.countInputTokens).not.toHaveBeenCalled();
});
