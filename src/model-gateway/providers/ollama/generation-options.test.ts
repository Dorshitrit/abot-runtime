import { describe, expect, test } from "vitest";

import { MODEL_STEPS } from "../../../shared/model-steps.js";
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

function physicalRemainder(payload: Readonly<Record<string, unknown>>): number {
  return Math.max(
    1,
    4_096 - estimateProviderEnvelopeInputTokens(payload, TOKEN_ESTIMATION),
  );
}

describe("Ollama generation allowance", () => {
  test.each([
    MODEL_STEPS.SUPERVISOR_DECISION,
    MODEL_STEPS.PLANNER_DECISION,
    MODEL_STEPS.WORKER_DECISION,
    MODEL_STEPS.REVIEWER_DECISION,
    MODEL_STEPS.EXECUTION_DECISION,
  ])(
    "keeps the registered decision limit with a small schema for %s",
    (modelStep) => {
      const payload = buildOllamaPayload({
        agentMode: "fast",
        modelStep,
        format: SMALL_STRICT_DECISION_FORMAT,
        modelPolicy: OLLAMA_MODEL_POLICY,
      });

      expect(payload).toHaveProperty("options.num_predict", 2_048);
      expect(payload.format).toEqual(SMALL_STRICT_DECISION_FORMAT.schema);
    },
  );

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
    "keeps the physical bound when less room remains than the decision limit",
    (text) => {
      const payload = buildOllamaPayload({
        agentMode: "fast",
        modelStep: MODEL_STEPS.SUPERVISOR_DECISION,
        text,
        format: SMALL_STRICT_DECISION_FORMAT,
        modelPolicy: OLLAMA_MODEL_POLICY,
      });

      expect(physicalRemainder(payload)).toBeLessThan(2_048);
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
});
