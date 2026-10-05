import { expect, test } from "vitest";
import {
  generateSemanticCompactionCandidateBatched,
  createSemanticCompactionSha256Fingerprint as hash,
} from "../context/semantic-compaction/index.js";
import { SEMANTIC_COMPACTION_INSTRUCTIONS } from "../context/semantic-compaction/prompt.js";
import {
  semanticContractFixture,
  compactContinuation,
  readCompactionEnvelope,
  COMPACTION_FACT,
  CONFIGURED_COMPACTION_GUIDANCE,
  CALIBRATED_COMPACTION_GUIDANCE,
} from "./support/semantic-compaction-contract-fixture.js";

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test.each([false, true])(
    `S2/S3/S8: ${policy} retains the canonical bound through configured normal/slice assembly (%s)`,
    async (sliced) => {
      const fixture = semanticContractFixture({ policy, sliced });
      const oldSource = {
        sourceRef: "previous-source",
        content: "Earlier target observation.",
      };
      const previous = {
        ...fixture.params.binding,
        kind: "runtime_semantic_compaction_checkpoint_v2" as const,
        scopeId: fixture.params.scopeId,
        sourceRevision: 0,
        continuation: compactContinuation({ findings: [oldSource.content] }),
        sourceDigests: [
          {
            sourceRef: oldSource.sourceRef,
            sourceFingerprint: hash(oldSource.content),
            digest: oldSource.content,
          },
        ],
      };
      fixture.store.registerSources([
        { ...oldSource, sourceFingerprint: hash(oldSource.content) },
      ]);
      fixture.store.commit(previous);
      const candidate = await generateSemanticCompactionCandidateBatched({
        ...fixture.params,
        previous,
      });
      expect(candidate.continuation.currentState).toBe(COMPACTION_FACT);
      expect(candidate.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual(
        [oldSource.sourceRef, fixture.source.sourceRef],
      );
      expect(fixture.store.get(previous.scopeId)).toEqual(previous);
      for (const messages of [...fixture.captured, ...fixture.counted]) {
        if (
          readCompactionEnvelope(messages).kind ===
          "runtime_semantic_compaction_checkpoint_v2"
        )
          continue;
        const policyMessages = messages.filter(({ role }) => role === "system");
        // Assembly identity, not a snapshot of the instruction's prose.
        expect(
          policyMessages.some(({ content }) =>
            content.includes(SEMANTIC_COMPACTION_INSTRUCTIONS),
          ),
        ).toBe(true);
        expect(
          policyMessages.some(({ content }) =>
            content.includes(CONFIGURED_COMPACTION_GUIDANCE),
          ),
        ).toBe(true);
      }
      const calibration =
        fixture.params.request.modelPolicy?.profiles?.["contract-model"]
          ?.calibration?.["context.compact"];
      expect(calibration?.instructions).toEqual([
        CALIBRATED_COMPACTION_GUIDANCE,
      ]);
      for (const payload of fixture.providerPayloads) {
        const input = (payload.input as { content: string }[])
          .map(({ content }) => content)
          .join("\n");
        expect(input).toContain(CALIBRATED_COMPACTION_GUIDANCE);
        expect(input).toContain(CONFIGURED_COMPACTION_GUIDANCE);
        expect(input).toContain(SEMANTIC_COMPACTION_INSTRUCTIONS);
      }
      const envelopes = fixture.captured.map(readCompactionEnvelope);
      if (!sliced) {
        expect(envelopes).toHaveLength(1);
        expect(envelopes[0]?.previousContinuation).toEqual(
          previous.continuation,
        );
        return;
      }
      expect(envelopes.length).toBeGreaterThan(1);
      expect(
        envelopes.every(({ sourceSlice }) => sourceSlice !== undefined),
      ).toBe(true);
      expect(
        envelopes
          .slice(1)
          .every(({ partialSourceFold }) => partialSourceFold !== undefined),
      ).toBe(true);
      expect(
        envelopes.map(({ sourceSlice }) => sourceSlice!.content).join(""),
      ).toBe(fixture.source.content);
    },
  );
}
