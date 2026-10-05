import { semanticCompactionReplacementSlots } from "./support/semantic-compaction-replacement-fixture.js";
import { expect, test } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  SEMANTIC_COMPACTION_CONTEXT_LANE,
} from "../context/semantic-compaction/contracts.js";
import { generateSemanticCompactionCandidateBatched } from "../context/semantic-compaction/run.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../orchestration/worker-capabilities/payload-contracts.js";

test.each([1, 2])(
  "A5 failed slice %i leaves the full immutable source and prior checkpoint intact",
  async (failedSlice) => {
    const { request, call, view, invoke } =
      await createSuperCompactionSourceFixture();
    const initial = readSuperWorkerCompactionSidecar(view)!.sources[0]!;
    const large = createCapabilityResultCompactionSource({
      ...JSON.parse(initial.content),
      executionId: "capability-execution-2",
      adapterResult: {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: true,
        payload: { evidence: "Long exact evidence. ".repeat(18000) },
      },
    });
    const binding = {
      requestId: request.requestId,
      currentRequestFingerprint: hash(request.prompt),
      roleId: "worker",
      callId: call.callId,
      objectiveFingerprint: hash(call.objective!),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    };
    const scopeId = `worker:${call.callId}:request-tool-results`;
    const continuation = {
      completed: ["Catalog read"],
      currentState: "Catalog evidence is available.",
      findings: ["Exact facts retained."],
      evidenceRefs: [initial.sourceRef],
      artifacts: [],
      decisions: [],
      failedApproaches: [],
      openWork: ["Read remaining evidence."],
      blockers: [],
      nextStep: "Continue the bounded objective.",
    };
    const store = request.contextCompactionStore!;
    store.registerSourcesAtomically!([initial]);
    store.commit({
      kind: "runtime_semantic_compaction_checkpoint_v2",
      ...binding,
      scopeId,
      sourceRevision: view.sourceRevision,
      sourceDigests: [
        {
          sourceRef: initial.sourceRef,
          sourceFingerprint: initial.sourceFingerprint,
          digest: "Catalog facts.",
        },
      ],
      continuation,
    });
    const previous = store.get(scopeId)!;
    const slices: string[] = [];
    invoke.mockImplementation(
      async (input: Parameters<ModelGatewayClient["invoke"]>[0]) => {
        const messages = input.messages as readonly { content: string }[];
        const payload = JSON.parse(messages.at(-1)!.content);
        expect(payload.sourceSlice.sourceRef).toBe(large.sourceRef);
        expect(payload.sourceSlice.sourceFingerprint).toBe(
          large.sourceFingerprint,
        );
        expect(payload.sourceSlice.content.length).toBeLessThan(
          large.content.length,
        );
        slices.push(payload.sourceSlice.content);
        if (slices.length === failedSlice)
          throw new Error("fixture_slice_failure");
        return {
          text: JSON.stringify({
            continuation,
            sourceDigests: semanticCompactionReplacementSlots(
              payload,
              () => "Additional observed facts retained.",
            ),
          }),
          meta: {},
        };
      },
    );
    await expect(
      generateSemanticCompactionCandidateBatched({
        request,
        consumer: "worker.decision",
        binding,
        scopeId,
        sourceRevision: view.sourceRevision + 1,
        preservationObjective: call.objective!,
        previous,
        sources: [large],
        registrationMode: "atomic",
      }),
    ).rejects.toThrow("fixture_slice_failure");
    expect(slices).toHaveLength(failedSlice);
    expect(store.get(scopeId)).toEqual(previous);
    expect(
      store.materializeSource(large.sourceRef, large.sourceFingerprint),
    ).toEqual(large);
    expect(store.snapshot!().sources).toEqual([initial, large]);
  },
);
