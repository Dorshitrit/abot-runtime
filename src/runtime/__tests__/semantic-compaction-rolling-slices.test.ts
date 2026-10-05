import { expect, test } from "vitest";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  generateSemanticCompactionCandidateBatched,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/index.js";
import {
  compactContinuation,
  semanticContractFixture,
} from "./support/semantic-compaction-contract-fixture.js";

type SliceEnvelope = {
  previousCheckpoint?: {
    sourceDigests: { sourceKey: string; digest: string }[];
  };
  partialSourceFold?: {
    coveredThroughByte: number;
    sourceDigests: { sourceKey: string; digest: string }[];
  };
  sourceSlice: {
    sourceKey: string;
    sourceRef: string;
    sourceFingerprint: string;
    sliceFingerprint: string;
    content: string;
    range: { startByte: number; endByteExclusive: number; totalBytes: number };
  };
};

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s carries all rolling digests through contiguous UTF-8 source slices",
  async (policy) => {
    const fixture = semanticContractFixture({ policy });
    const earlierSource = {
      sourceRef: "earlier",
      content: "Earlier evidence",
      sourceFingerprint: hash("Earlier evidence"),
    };
    const source = {
      sourceRef: "multibyte",
      content: "Aא😀éב🌍Z",
      sourceFingerprint: hash("Aא😀éב🌍Z"),
    };
    const previous: SemanticCompactionCheckpoint = {
      kind: "runtime_semantic_compaction_checkpoint_v2",
      ...fixture.params.binding,
      scopeId: fixture.params.scopeId,
      sourceRevision: 0,
      sourceDigests: [
        {
          sourceRef: earlierSource.sourceRef,
          sourceFingerprint: earlierSource.sourceFingerprint,
          digest: "Earlier digest",
        },
      ],
      continuation: compactContinuation(),
    };
    fixture.store.registerSources([earlierSource]);
    fixture.store.commit(previous);
    const originalCounter = fixture.countInputTokens.getMockImplementation()!;
    fixture.countInputTokens.mockImplementation(async (input) => {
      const measured = (await originalCounter(input))!;
      const envelope = JSON.parse(
        (input.messages as { content: string }[]).at(-1)!.content,
      );
      if (envelope.kind === "runtime_semantic_compaction_checkpoint_v2")
        return { ...measured, inputTokens: 1_000 };
      if (!envelope.sourceSlice) return { ...measured, inputTokens: 14_000 };
      return {
        ...measured,
        inputTokens:
          Buffer.byteLength(envelope.sourceSlice.content, "utf8") <= 8
            ? 1_000
            : 14_000,
      };
    });
    const invoked: SliceEnvelope[] = [];
    fixture.invoke.mockImplementation(async (input) => {
      const envelope = JSON.parse(
        (input.messages as { content: string }[]).at(-1)!.content,
      ) as SliceEnvelope;
      invoked.push(envelope);
      return {
        text: JSON.stringify({
          continuation: compactContinuation(),
          sourceDigests: {
            source_0: `Earlier digest replacement ${invoked.length}`,
            source_1: `Source covered through byte ${envelope.sourceSlice.range.endByteExclusive}`,
          },
        }),
        meta: {},
      };
    });
    const candidate = await generateSemanticCompactionCandidateBatched({
      ...fixture.params,
      previous,
      sources: [source],
    });
    expect(invoked.length).toBeGreaterThan(1);
    expect(invoked[0]?.previousCheckpoint?.sourceDigests).toEqual([
      expect.objectContaining({
        sourceKey: "source_0",
        digest: "Earlier digest",
      }),
    ]);
    expect(invoked[0]).not.toHaveProperty("partialSourceFold");
    let nextByte = 0;
    for (const [index, envelope] of invoked.entries()) {
      const slice = envelope.sourceSlice;
      expect(slice).toMatchObject({
        sourceKey: "source_1",
        sourceRef: source.sourceRef,
        sourceFingerprint: source.sourceFingerprint,
      });
      expect(slice.content).not.toContain("\uFFFD");
      expect(slice.range.startByte).toBe(nextByte);
      expect(slice.range.endByteExclusive - slice.range.startByte).toBe(
        Buffer.byteLength(slice.content, "utf8"),
      );
      expect(slice.range.totalBytes).toBe(
        Buffer.byteLength(source.content, "utf8"),
      );
      expect(slice.sliceFingerprint).toBe(hash(slice.content));
      if (index > 0) {
        expect(envelope).not.toHaveProperty("previousCheckpoint");
        expect(envelope.partialSourceFold).toEqual({
          coveredThroughByte: nextByte,
          continuation: compactContinuation(),
          sourceDigests: [
            expect.objectContaining({
              sourceKey: "source_0",
              digest: `Earlier digest replacement ${index}`,
            }),
            expect.objectContaining({
              sourceKey: "source_1",
              digest: `Source covered through byte ${nextByte}`,
            }),
          ],
        });
      }
      nextByte = slice.range.endByteExclusive;
    }
    expect(invoked.map(({ sourceSlice }) => sourceSlice.content).join("")).toBe(
      source.content,
    );
    expect(nextByte).toBe(Buffer.byteLength(source.content, "utf8"));
    expect(candidate.sourceDigests).toEqual([
      {
        sourceRef: earlierSource.sourceRef,
        sourceFingerprint: earlierSource.sourceFingerprint,
        digest: `Earlier digest replacement ${invoked.length}`,
      },
      {
        sourceRef: source.sourceRef,
        sourceFingerprint: source.sourceFingerprint,
        digest: `Source covered through byte ${nextByte}`,
      },
    ]);
    expect(fixture.store.get(fixture.params.scopeId)).toEqual(previous);
  },
);
