import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type {
  ModelGatewayPolicyConfig,
  ModelGatewayRequest,
} from "../../types.js";
import { estimateProviderEnvelopeInputTokens } from "../envelope-budget.js";
import { buildOllamaPayload, buildOllamaRawPayload } from "./payload.js";

const SMALL_STRICT_DECISION_FORMAT = {
  type: "json_schema" as const,
  name: "small_strict_decision",
  strict: true,
  schema: {
    type: "object",
    properties: {
      decision: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["invoke_role"] },
          roleId: { type: "string", enum: ["reviewer"] },
        },
        required: ["action", "roleId"],
        additionalProperties: false,
      },
    },
    required: ["decision"],
    additionalProperties: false,
  },
};

const TOKEN_ESTIMATION = {
  asciiCharactersPerToken: 4,
  nonAsciiBytesPerToken: 2,
  messageOverheadTokens: 6,
};

const OLLAMA_MODEL_POLICY = {
  providers: { ollama: { type: "ollama" as const } },
  profiles: {
    local: {
      provider: "ollama",
      model: "local-model",
      contextWindowTokens: 4_096,
      supportsThinking: true,
      context: { tokenEstimation: TOKEN_ESTIMATION },
    },
  },
  defaults: { profileId: "local" },
};

const DECISION_STEPS = [
  MODEL_STEPS.SUPERVISOR_DECISION,
  MODEL_STEPS.WORKER_EVIDENCE,
  MODEL_STEPS.WORKER_DECISION,
  MODEL_STEPS.PLANNER_DECISION,
  MODEL_STEPS.REVIEWER_DECISION,
  MODEL_STEPS.EXECUTION_DECISION,
  MODEL_STEPS.AUDITOR_DECISION,
];

beforeEach(() => vi.stubEnv("OLLAMA_NUM_PREDICT", ""));
afterEach(() => vi.unstubAllEnvs());

function physicalRemainder(payload: Readonly<Record<string, unknown>>): number {
  return Math.max(
    1,
    4_096 - estimateProviderEnvelopeInputTokens(payload, TOKEN_ESTIMATION),
  );
}

describe("Ollama generation allowance", () => {
  describe.each(DECISION_STEPS)("%s", (modelStep) => {
    test.each([
      ["fast", false],
      ["reasoning", "medium"],
      ["deep", "high"],
    ] as const)(
      "allows thinking and answer room in %s mode",
      (agentMode, think) => {
        const payload = buildOllamaPayload({
          agentMode,
          modelStep,
          format: SMALL_STRICT_DECISION_FORMAT,
          modelPolicy: OLLAMA_MODEL_POLICY,
        });

        expect(physicalRemainder(payload)).toBeGreaterThan(2_048);
        expect(payload).toHaveProperty(
          "options.num_predict",
          physicalRemainder(payload),
        );
        expect(payload.think).toBe(think);
        expect(payload.format).toEqual(SMALL_STRICT_DECISION_FORMAT.schema);
      },
    );

    test.each([false, undefined])(
      "allows server-default thinking with supportsThinking=%s",
      (supportsThinking) => {
        const payload = buildOllamaPayload({
          agentMode: "deep",
          modelStep,
          modelPolicy: {
            ...OLLAMA_MODEL_POLICY,
            profiles: {
              local: {
                ...OLLAMA_MODEL_POLICY.profiles.local,
                supportsThinking,
              },
            },
          },
        });

        expect(payload).not.toHaveProperty("think");
        expect(physicalRemainder(payload)).toBeGreaterThan(2_048);
        expect(payload).toHaveProperty(
          "options.num_predict",
          physicalRemainder(payload),
        );
      },
    );

    test("raw requests retain disabled thinking and use the same finite allowance", () => {
      const payload = buildOllamaRawPayload({
        agentMode: "deep",
        modelStep,
        prompt: "Choose the next action.",
        format: SMALL_STRICT_DECISION_FORMAT,
        modelPolicy: OLLAMA_MODEL_POLICY,
      });

      expect(payload.think).toBe(false);
      expect(physicalRemainder(payload)).toBeGreaterThan(2_048);
      expect(payload).toHaveProperty(
        "options.num_predict",
        physicalRemainder(payload),
      );
      expect(payload.format).toEqual(SMALL_STRICT_DECISION_FORMAT.schema);
    });
  });

  test("uses the physical remainder for controls without a registered output limit", () => {
    const payload = buildOllamaPayload({
      agentMode: "fast",
      modelStep: MODEL_STEPS.CAPABILITY_CONTROLS,
      format: SMALL_STRICT_DECISION_FORMAT,
      modelPolicy: OLLAMA_MODEL_POLICY,
    });

    expect(physicalRemainder(payload)).toBeGreaterThan(2_048);
    expect(payload).toHaveProperty(
      "options.num_predict",
      physicalRemainder(payload),
    );
  });

  test("preserves a complete bounded batch schema without limiting generation by its size", () => {
    const format = {
      type: "json_schema" as const,
      name: "bounded_batch",
      strict: true,
      schema: {
        type: "object",
        properties: {
          invocations: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: SMALL_STRICT_DECISION_FORMAT.schema,
          },
        },
        required: ["invocations"],
        additionalProperties: false,
      },
    };
    const payload = buildOllamaPayload({
      agentMode: "fast",
      modelStep: MODEL_STEPS.CAPABILITY_CONTROLS,
      format,
      modelPolicy: OLLAMA_MODEL_POLICY,
    });

    expect(payload.format).toEqual(format.schema);
    expect(payload).toHaveProperty(
      "options.num_predict",
      physicalRemainder(payload),
    );
  });

  test.each(["x".repeat(10_000), "x".repeat(20_000)])(
    "keeps a positive finite allowance when little or no estimated room remains",
    (text) => {
      const payload = buildOllamaPayload({
        agentMode: "fast",
        modelStep: MODEL_STEPS.SUPERVISOR_DECISION,
        text,
        format: SMALL_STRICT_DECISION_FORMAT,
        modelPolicy: OLLAMA_MODEL_POLICY,
      });

      expect(physicalRemainder(payload)).toBeLessThan(2_048);
      expect(physicalRemainder(payload)).toBeGreaterThanOrEqual(1);
      expect(payload).toHaveProperty(
        "options.num_predict",
        physicalRemainder(payload),
      );
    },
  );

  test("leaves raw output on its existing physical-remainder allowance", () => {
    const payload = buildOllamaRawPayload({
      prompt: "Write the requested content.",
      modelStep: MODEL_STEPS.TOOL_PAYLOAD_RAW,
      modelPolicy: OLLAMA_MODEL_POLICY,
    });

    expect(payload).toHaveProperty(
      "options.num_predict",
      physicalRemainder(payload),
    );
  });

  test("preserves messages, schema, sampling, context and thinking across step selection", () => {
    const request: ModelGatewayRequest = {
      agentMode: "deep",
      messages: [
        { role: "system", content: "Choose a permitted action." },
        { role: "user", content: "Continue the current request." },
      ],
      format: SMALL_STRICT_DECISION_FORMAT,
      modelPolicy: {
        ...OLLAMA_MODEL_POLICY,
        profiles: {
          local: {
            ...OLLAMA_MODEL_POLICY.profiles.local,
            generation: { temperature: 0.25, topP: 0.8 },
          },
        },
      },
    };
    const baseline = buildOllamaPayload({
      ...request,
      modelStep: MODEL_STEPS.CAPABILITY_CONTROLS,
    });

    expect(baseline.messages).toEqual(request.messages);
    expect(baseline.format).toEqual(SMALL_STRICT_DECISION_FORMAT.schema);
    expect(baseline.options).toMatchObject({
      num_ctx: 4_096,
      temperature: 0.25,
      top_p: 0.8,
    });
    for (const modelStep of DECISION_STEPS) {
      expect(buildOllamaPayload({ ...request, modelStep })).toEqual(baseline);
    }
  });
});

describe.each([
  ["chat", buildOllamaPayload],
  ["raw", buildOllamaRawPayload],
] as const)("Ollama %s explicit generation limits", (_, buildPayload) => {
  test.each([640, 8_192, -1, 0])(
    "honors provider-native num_predict=%s for decisions and other steps",
    (numPredict) => {
      const modelPolicy: ModelGatewayPolicyConfig = {
        ...OLLAMA_MODEL_POLICY,
        profiles: {
          local: {
            ...OLLAMA_MODEL_POLICY.profiles.local,
            options: { num_predict: numPredict },
          },
        },
      };
      for (const modelStep of [
        ...DECISION_STEPS,
        MODEL_STEPS.CAPABILITY_CONTROLS,
        MODEL_STEPS.TOOL_PAYLOAD_RAW,
      ]) {
        const payload = buildPayload({
          agentMode: "deep",
          modelStep,
          modelPolicy,
        });
        expect(payload).toHaveProperty("options.num_predict", numPredict);
      }
    },
  );

  test("gives a positive environment override precedence over profile settings", () => {
    vi.stubEnv("OLLAMA_NUM_PREDICT", "960");
    const payload = buildPayload({
      agentMode: "deep",
      modelStep: MODEL_STEPS.EXECUTION_DECISION,
      modelPolicy: {
        ...OLLAMA_MODEL_POLICY,
        profiles: {
          local: {
            ...OLLAMA_MODEL_POLICY.profiles.local,
            options: { num_predict: 640 },
          },
        },
      },
    });
    expect(payload).toHaveProperty("options.num_predict", 960);
  });

  test.each(["invalid", "0", "-1"])(
    "ignores non-positive or invalid environment values: %s",
    (value) => {
      vi.stubEnv("OLLAMA_NUM_PREDICT", value);
      const request = {
        modelStep: MODEL_STEPS.EXECUTION_DECISION,
        modelPolicy: OLLAMA_MODEL_POLICY,
      };
      const payload = buildPayload(request);
      expect(payload).toHaveProperty(
        "options.num_predict",
        physicalRemainder(payload),
      );
      const explicit = buildPayload({
        ...request,
        modelPolicy: {
          ...OLLAMA_MODEL_POLICY,
          profiles: {
            local: {
              ...OLLAMA_MODEL_POLICY.profiles.local,
              options: { num_predict: 640 },
            },
          },
        },
      });
      expect(explicit).toHaveProperty("options.num_predict", 640);
    },
  );
});
