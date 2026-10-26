import { expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "../context/semantic-compaction/generation-contracts.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { generateSuperCompactionCandidate } from "../context/super-compaction/run.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

function fixture(finalCheckpointTokens: number) {
  const checkpointCounts: number[] = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: "Observed receipts retained; the original assignment remains open.",
    meta: {},
  }));
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    const envelope = JSON.parse(
      messages.find((message) => message.role === "user")!.content,
    );
    let inputTokens = 1_000;
    if (envelope.kind === "runtime_semantic_compaction_checkpoint_v2") {
      if (
        envelope.coveredSources.some((source: { digest: string }) => source.digest)
      )
        inputTokens = finalCheckpointTokens;
      checkpointCounts.push(inputTokens);
    }
    return {
      inputTokens,
      profileId: "compact-test-profile",
      provider: "ollama",
      model: "compact-test-model",
      contextWindowTokens: 16_000,
      source: "provider_input_token_count",
    };
  });
  const original = createCompactionRequest({
    requestId: "super-checkpoint-budget",
    prompt: "Preserve the observed tool receipts.",
    invoke,
  });
  const request = deriveTestRequestExecutionScope(original, {
    ...projectSuperCompactionConfiguration(
      original,
      original.executionPolicy.authority,
    ),
    // Use the supplied measurement unchanged, including the final checkpoint.
    modelGatewayClient: { ...original.modelGatewayClient, countInputTokens },
  });
  const sources = Array.from({ length: 12 }, (_, index) => {
    const content = `Receipt ${index}: check ${index} passed; full suite not run.`;
    return {
      sourceRef: `receipt-${index}`,
      sourceFingerprint: hash(content),
      content,
    };
  });
  const objective = "Preserve every observed receipt without claiming completion.";
  const params: SemanticCompactionGenerationParams = {
    request,
    scopeId: "role:worker:checkpoint-budget",
    sourceRevision: 1,
    preservationObjective: objective,
    binding: {
      requestId: request.requestId,
      currentRequestFingerprint: hash(request.prompt),
      roleId: "worker",
      callId: "worker-budget",
      objectiveFingerprint: hash(objective),
      contextLane: "role_continuation",
      allowedConsumers: ["worker.result"],
    },
    consumer: "worker.result",
    sources,
  };
  return { params, sources, invoke, checkpointCounts };
}

test("admits twelve short retained receipts when writing targets exceed a 16k consumer allowance", async () => {
  const f = fixture(1_200);
  const candidate = await generateSuperCompactionCandidate(f.params);

  expect(candidate.sourceDigests).toHaveLength(f.sources.length);
  for (const [index, source] of f.sources.entries()) {
    expect(candidate.sourceDigests[index]).toEqual({
      sourceRef: source.sourceRef,
      sourceFingerprint: source.sourceFingerprint,
      digest: `Retained source (verbatim):\n${source.content}\nEnd of retained source.`,
    });
  }
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(
    Array(12).fill("super.compact.continuation"),
  );
  // 4,800 - 1,000 skeleton - 1,000 handoff < twelve 256-character targets.
  expect(f.checkpointCounts).toEqual([1_000, 1_200]);
});

test("rejects an actually oversized checkpoint after retaining the same receipts", async () => {
  const f = fixture(4_801);

  await expect(generateSuperCompactionCandidate(f.params)).rejects.toThrow(
    "context_compaction_checkpoint_tokens_exceeded",
  );

  expect(f.invoke).toHaveBeenCalledTimes(12);
  expect(f.checkpointCounts).toEqual([1_000, 4_801]);
});
