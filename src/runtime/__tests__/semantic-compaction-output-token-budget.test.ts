import { expect, test } from "vitest";
import { prepareReplacementCompactionBudget } from "../context/semantic-compaction/replacement-budget.js";
import { validateSemanticCompactionOutput } from "../context/semantic-compaction/output-validation.js";
import { SEMANTIC_COMPACTION_BATCH_VALIDATION } from "../context/semantic-compaction/repair-headroom.js";
import { buildCheckpointMessage } from "../context/semantic-compaction/checkpoint-message.js";
import { estimateMessagesTokens } from "../context/token-estimator.js";
import {
  compactContinuation,
  semanticContractFixture,
} from "./support/semantic-compaction-contract-fixture.js";

function checkpointOutput(digest = "Observed evidence.") {
  return JSON.stringify({
    continuation: compactContinuation(),
    sourceDigests: { source_0: digest },
  });
}

function outputValidationFixture() {
  const fixture = semanticContractFixture();
  const budget = prepareReplacementCompactionBudget(fixture.params);
  const measurement = (inputTokens: number) => ({
    inputTokens,
    profileId: budget.admission.invocation.profile.id,
    provider: budget.admission.invocation.profile.provider,
    model: budget.admission.invocation.model,
    contextWindowTokens: budget.admission.budget.contextWindowTokens,
    source: "provider_input_token_count" as const,
  });
  const validate = (text: string) =>
    validateSemanticCompactionOutput(
      text,
      fixture.params,
      budget,
      SEMANTIC_COMPACTION_BATCH_VALIDATION,
    );
  return { ...fixture, budget, measurement, validate };
}

test.each([
  ["execution-agent-v1", 32_000, 9_600],
  ["execution-agent-v1", 120_000, 36_000],
  ["supervisor-worker-v1", 32_000, 9_600],
  ["supervisor-worker-v1", 120_001, 36_000],
] as const)(
  "%s gives a %i-token consumer one %i-token checkpoint allowance",
  (policy, contextWindowTokens, expected) => {
    const { params } = semanticContractFixture({ policy, contextWindowTokens });
    expect(
      prepareReplacementCompactionBudget(params).checkpointTokenAllowance,
    ).toBe(expected);
  },
);

test("uses the explicitly selected consumer profile rather than the compactor profile", () => {
  const { params } = semanticContractFixture();
  const selected = {
    ...params,
    consumer: "worker.result" as const,
    binding: {
      ...params.binding,
      allowedConsumers: ["worker.decision", "worker.result"] as const,
    },
    request: {
      ...params.request,
      modelPolicy: {
        providers: { test: { type: "openai" as const } },
        profiles: {
          consumer: {
            provider: "test",
            model: "consumer-model",
            contextWindowTokens: 32_000,
          },
          compactor: {
            provider: "test",
            model: "compactor-model",
            contextWindowTokens: 120_000,
          },
        },
        defaults: {
          profileId: "compactor",
          steps: {
            "worker.result": "consumer",
            "context.compact": "compactor",
          },
        },
      },
    },
  };
  const budget = prepareReplacementCompactionBudget(selected);
  expect(budget.consumer).toBe("worker.result");
  expect(budget.admission.invocation.profile.id).toBe("consumer");
  expect(budget.checkpointTokenAllowance).toBe(9_600);
  expect(() =>
    prepareReplacementCompactionBudget({
      ...selected,
      consumer: "execution.decision",
    }),
  ).toThrow("context_compaction_budget_consumer_invalid");
});

test.each([
  [4_800, true],
  [4_801, false],
] as const)(
  "measured checkpoint size %i respects the inclusive allowance boundary",
  async (inputTokens, accepted) => {
    const fixture = outputValidationFixture();
    fixture.countInputTokens.mockResolvedValue(
      fixture.measurement(inputTokens),
    );
    const result = await fixture.validate(checkpointOutput());
    expect(result.ok).toBe(accepted);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(
        "context_compaction_checkpoint_tokens_exceeded",
      );
      expect(result.issues[0]?.message).toContain(String(inputTokens));
      expect(result.issues[0]?.message).toContain(
        String(fixture.budget.checkpointTokenAllowance),
      );
    }
    expect(fixture.store.get(fixture.params.scopeId)).toBeUndefined();
  },
);

test("measures the entire projected checkpoint and preserves a long uneven source digest intact", async () => {
  const fixture = outputValidationFixture();
  const digest = "ממצא 😀 exact-value=701; ".repeat(1_000);
  fixture.countInputTokens.mockResolvedValue(fixture.measurement(4_000));
  const result = await fixture.validate(checkpointOutput(digest.trim()));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("checkpoint unexpectedly rejected");
  expect(result.decision.sourceDigests[0]?.digest).toBe(digest.trim());
  const [input] = fixture.countInputTokens.mock.calls[0]!;
  const candidate = {
    ...fixture.params.binding,
    kind: "runtime_semantic_compaction_checkpoint_v2" as const,
    scopeId: fixture.params.scopeId,
    sourceRevision: fixture.params.sourceRevision,
    ...result.decision,
  };
  expect(input.modelStep).toBe(fixture.budget.consumer);
  expect(input.format).toEqual({ type: "text" });
  expect(input.messages).toEqual([buildCheckpointMessage(candidate)]);
  expect(
    estimateMessagesTokens(
      [buildCheckpointMessage(candidate)],
      fixture.budget.admission.budget.tokenEstimation,
    ),
  ).toBeGreaterThan(fixture.budget.checkpointTokenAllowance);
});

test.each([undefined, "absent"] as const)(
  "uses the estimator when provider counting is %s",
  async (mode) => {
    const fixture = outputValidationFixture();
    const request =
      mode === "absent"
        ? {
            ...fixture.params.request,
            modelGatewayClient: {
              invoke: fixture.invoke,
              invokeRaw: fixture.params.request.modelGatewayClient.invokeRaw,
            },
          }
        : fixture.params.request;
    fixture.countInputTokens.mockResolvedValue(undefined);
    const validate = (text: string) =>
      validateSemanticCompactionOutput(
        text,
        { ...fixture.params, request },
        fixture.budget,
        SEMANTIC_COMPACTION_BATCH_VALIDATION,
      );
    expect((await validate(checkpointOutput())).ok).toBe(true);
    const oversized = await validate(
      checkpointOutput("semantic detail ".repeat(20_000).trim()),
    );
    expect(oversized).toMatchObject({
      ok: false,
      issues: [{ code: "context_compaction_checkpoint_tokens_exceeded" }],
    });
  },
);

test("rejects malformed source identity before consulting provider counting", async () => {
  const fixture = outputValidationFixture();
  const result = await fixture.validate(
    JSON.stringify({
      continuation: compactContinuation(),
      sourceDigests: { wrong_source: "Observed evidence." },
    }),
  );
  expect(result).toMatchObject({
    ok: false,
    issues: [{ code: "context_compaction_sources_invalid" }],
  });
  expect(fixture.countInputTokens).not.toHaveBeenCalled();
});

test.each([
  { profileId: "other-profile" },
  { provider: "ollama" as const },
  { model: "other-model" },
  { contextWindowTokens: 120_000 },
])(
  "rejects a provider measurement from a different binding: %j",
  async (mismatch) => {
    const fixture = outputValidationFixture();
    fixture.countInputTokens.mockResolvedValue({
      ...fixture.measurement(1),
      ...mismatch,
    });
    await expect(fixture.validate(checkpointOutput())).rejects.toThrow(
      "model_input_token_count_binding_mismatch",
    );
  },
);

test("does not replace a provider counting failure with a permissive estimate", async () => {
  const fixture = outputValidationFixture();
  fixture.countInputTokens.mockRejectedValue(
    new Error("provider_count_unavailable"),
  );
  await expect(fixture.validate(checkpointOutput())).rejects.toThrow(
    "provider_count_unavailable",
  );
});
