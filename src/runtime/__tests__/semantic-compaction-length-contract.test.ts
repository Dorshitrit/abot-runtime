import { expect, test } from "vitest";
import {
  parseSemanticCompactionOutput,
  generateSemanticCompactionCandidateBatched,
} from "../context/semantic-compaction/index.js";
import { STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS } from "../model/repair-prompts.js";
import {
  compactContinuation,
  semanticContractFixture,
  COMPACTION_FACT,
} from "./support/semantic-compaction-contract-fixture.js";
import { semanticCompactionDigestSlots } from "./support/semantic-compaction-model-fixture.js";

test("preserves an aggregate continuation above the former character quota", () => {
  const { source } = semanticContractFixture();
  const continuation = compactContinuation({
    currentState: "😀".repeat(1000),
    nextStep: "N".repeat(2000),
    findings: ["F".repeat(2000), "G".repeat(2000), "exact final finding"],
  });
  expect(
    parseSemanticCompactionOutput(
      JSON.stringify({
        continuation,
        sourceDigests: semanticCompactionDigestSlots([COMPACTION_FACT]),
      }),
      [source],
    ),
  ).toEqual({
    ok: true,
    continuation,
    sourceDigests: [
      {
        sourceRef: source.sourceRef,
        sourceFingerprint: source.sourceFingerprint,
        digest: COMPACTION_FACT,
      },
    ],
  });
});

test.each([
  { currentState: "x".repeat(2001) },
  { findings: Array.from({ length: 25 }, () => "finding") },
])("retains individual continuation structural bounds: %j", (overrides) => {
  const { source } = semanticContractFixture();
  expect(
    parseSemanticCompactionOutput(
      JSON.stringify({
        continuation: compactContinuation(overrides),
        sourceDigests: semanticCompactionDigestSlots([COMPACTION_FACT]),
      }),
      [source],
    ),
  ).toEqual({
    ok: false,
    issueCode: "context_compaction_continuation_invalid",
  });
});

test("repairs an oversized measured checkpoint without altering source bytes or committing early", async () => {
  const large = "Preserved detail ".repeat(600).trim();
  const fixture = semanticContractFixture({
    output: (attempt) =>
      JSON.stringify({
        continuation: compactContinuation(),
        sourceDigests: semanticCompactionDigestSlots([
          attempt === 1 ? large : COMPACTION_FACT,
        ]),
      }),
  });
  const originalCounter = fixture.countInputTokens.getMockImplementation()!;
  fixture.countInputTokens.mockImplementation(async (input) => {
    const measured = (await originalCounter(input))!;
    const containsLargeDigest = JSON.stringify(input.messages).includes(large);
    return { ...measured, inputTokens: containsLargeDigest ? 4_801 : 1_000 };
  });
  const candidate = await generateSemanticCompactionCandidateBatched(
    fixture.params,
  );
  expect(fixture.invoke).toHaveBeenCalledTimes(2);
  expect(candidate.sourceDigests[0]?.digest).toBe(COMPACTION_FACT);
  expect(
    fixture.store.materializeSource(
      fixture.source.sourceRef,
      fixture.source.sourceFingerprint,
    ),
  ).toEqual(fixture.source);
  expect(fixture.store.get(candidate.scopeId)).toBeUndefined();
  fixture.store.commit(candidate);
  expect(fixture.store.get(candidate.scopeId)).toEqual(candidate);
});

test("exhaustion leaves an earlier checkpoint unchanged", async () => {
  const fixture = semanticContractFixture({ output: () => "not-json" });
  const earlier = {
    ...fixture.params.binding,
    kind: "runtime_semantic_compaction_checkpoint_v2" as const,
    scopeId: fixture.params.scopeId,
    sourceRevision: 0,
    sourceDigests: [
      {
        sourceRef: "old-source",
        sourceFingerprint: fixture.source.sourceFingerprint,
        digest: COMPACTION_FACT,
      },
    ],
    continuation: compactContinuation(),
  };
  fixture.store.registerSources([
    { ...fixture.source, sourceRef: "old-source" },
  ]);
  fixture.store.commit(earlier);
  await expect(
    generateSemanticCompactionCandidateBatched({
      ...fixture.params,
      previous: earlier,
    }),
  ).rejects.toThrow();
  expect(fixture.invoke).toHaveBeenCalledTimes(
    STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS + 1,
  );
  expect(fixture.store.get(earlier.scopeId)).toEqual(earlier);
});
