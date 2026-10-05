import { expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import { prepareReplacementCompactionBudget } from "../context/semantic-compaction/replacement-budget.js";
import { validateSemanticCompactionOutput } from "../context/semantic-compaction/output-validation.js";
import { SEMANTIC_COMPACTION_BATCH_VALIDATION } from "../context/semantic-compaction/repair-headroom.js";
import {
  compactContinuation,
  semanticContractFixture,
} from "./support/semantic-compaction-contract-fixture.js";

function sharedFixture(
  options: {
    sameProfile?: boolean;
    calibratedInstructions?: boolean;
    tokens?: (step: string) => number;
  } = {},
) {
  const fixture = semanticContractFixture();
  const modelPolicy: ModelGatewayPolicyConfig = {
    providers: { test: { type: "openai" } },
    profiles: {
      large: {
        provider: "test",
        model: "large-model",
        contextWindowTokens: 120_000,
        ...(options.calibratedInstructions
          ? {
              calibration: {
                "worker.decision": {
                  instructions: ["Decision-specific instruction."],
                },
                "worker.result": {
                  instructions: ["Result-specific instruction."],
                },
              },
            }
          : {}),
      },
      small: {
        provider: "test",
        model: "small-model",
        contextWindowTokens: 32_000,
      },
    },
    defaults: {
      profileId: "large",
      steps: options.calibratedInstructions
        ? {
            "worker.decision": "worker.decision",
            "worker.result": "worker.result",
          }
        : {
            "worker.decision": "large",
            "worker.result": options.sameProfile ? "large" : "small",
          },
    },
  };
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async (input) => {
    const invocation = resolveModelInvocation(input);
    return {
      inputTokens: options.tokens?.(input.modelStep!) ?? 9_000,
      profileId: invocation.profile.id,
      provider: invocation.profile.provider,
      model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens,
      source: "provider_input_token_count",
    };
  });
  const params = {
    ...fixture.params,
    consumer: "worker.decision" as const,
    binding: {
      ...fixture.params.binding,
      allowedConsumers: ["worker.result", "worker.decision"] as const,
    },
    request: {
      ...fixture.params.request,
      modelPolicy,
      modelGatewayClient: {
        ...fixture.params.request.modelGatewayClient,
        countInputTokens,
      },
    },
  };
  const budget = prepareReplacementCompactionBudget(params);
  const validate = () =>
    validateSemanticCompactionOutput(
      JSON.stringify({
        continuation: compactContinuation(),
        sourceDigests: { source_0: "Exact observation." },
      }),
      params,
      budget,
      SEMANTIC_COMPACTION_BATCH_VALIDATION,
    );
  return { params, budget, countInputTokens, validate };
}

test("uses the invoking consumer first while limiting the shared checkpoint to its smallest window", () => {
  const { budget } = sharedFixture();
  expect(budget.consumer).toBe("worker.decision");
  expect(budget.admission.invocation.profile.id).toBe("large");
  expect(budget.checkpointTokenAllowance).toBe(9_600);
  expect(
    budget.consumers.map(({ consumer, checkpointTokenAllowance }) => [
      consumer,
      checkpointTokenAllowance,
    ]),
  ).toEqual([
    ["worker.decision", 36_000],
    ["worker.result", 9_600],
  ]);
});

test.each([
  [9_600, true],
  [9_601, false],
] as const)(
  "measures the smaller consumer independently at its inclusive %i-token boundary",
  async (smallTokens, accepted) => {
    const fixture = sharedFixture({
      tokens: (step) => (step === "worker.result" ? smallTokens : 9_000),
    });
    const result = await fixture.validate();
    expect(result.ok).toBe(accepted);
    expect(
      fixture.countInputTokens.mock.calls.map(([input]) => input.modelStep),
    ).toEqual(["worker.decision", "worker.result"]);
    expect(
      fixture.countInputTokens.mock.calls.every(
        ([input]) => typeof input.format === "object" && input.format?.type === "text",
      ),
    ).toBe(true);
    if (!result.ok)
      expect(result.issues[0]?.code).toBe(
        "context_compaction_checkpoint_tokens_exceeded",
      );
  },
);

test("counts identical effective consumer profiles only once, using the active step", async () => {
  const fixture = sharedFixture({ sameProfile: true });
  expect((await fixture.validate()).ok).toBe(true);
  expect(fixture.countInputTokens).toHaveBeenCalledTimes(1);
  expect(fixture.countInputTokens.mock.calls[0]![0].modelStep).toBe(
    "worker.decision",
  );
});

test("does not deduplicate calibrations that add different provider instructions", async () => {
  const fixture = sharedFixture({ calibratedInstructions: true });
  expect((await fixture.validate()).ok).toBe(true);
  expect(fixture.countInputTokens).toHaveBeenCalledTimes(2);
});

test("rejects an ambiguous caller but preserves inference for a single allowed consumer", () => {
  const { params } = sharedFixture();
  expect(() =>
    prepareReplacementCompactionBudget({ ...params, consumer: undefined }),
  ).toThrow("context_compaction_budget_consumer_invalid");
  expect(
    prepareReplacementCompactionBudget({
      ...params,
      consumer: undefined,
      binding: { ...params.binding, allowedConsumers: ["worker.result"] },
    }).consumer,
  ).toBe("worker.result");
});
