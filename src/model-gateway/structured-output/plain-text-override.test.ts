import { describe, expect, test } from "vitest";
import { resolveModelInvocation } from "../invocation-policy.js";
import { buildOllamaPayload } from "../providers/ollama/payload.js";
import type { ModelGatewayRequest } from "../types.js";
import {
  buildOpenAIInputTokenCountPayload,
  buildOpenAIResponsesPayload,
} from "../providers/openai/payload.js";
import {
  projectOllamaFormat,
  projectOpenAIResponsesFormat,
} from "./projection.js";

function request(format?: unknown, modelStep = "context.compact", provider: "openai" | "ollama" = "openai"): ModelGatewayRequest {
  return {
    modelStep,
    agentMode: "reasoning",
    messages: [
      {
        role: "system",
        content: "checkpoint evidence without output instructions",
      },
    ],
    ...(format === undefined ? {} : { format }),
    modelPolicy: {
      providers: { remote: { type: provider } },
      profiles: {
        fixture: {
          provider: "remote",
          model: "fixture",
          contextWindowTokens: 32_000,
          calibration: { [modelStep]: { format: "json" } },
        },
      },
      defaults: {
        profileId: "fixture",
        steps: { [modelStep]: modelStep },
      },
    },
  };
}

describe("explicit plain text for checkpoint measurement and SPARK authoring", () => {
  test.each(["context.compact", "learning.batch"])("%s overrides calibrated JSON mode for count and invocation", modelStep => {
    const input = request({ type: "text" }, modelStep);
    const before = structuredClone(input);
    for (const build of [
      buildOpenAIInputTokenCountPayload,
      buildOpenAIResponsesPayload,
    ]) {
      const payload = build(input);
      expect(payload).not.toHaveProperty("text");
      expect(payload.input).toEqual(input.messages);
    }
    expect(input).toEqual(before);
    expect(buildOpenAIInputTokenCountPayload(request(undefined, modelStep)).text).toEqual({
      format: { type: "json_object" },
    });
  });

  test("SPARK raw authoring bypasses Ollama JSON calibration while structured decisions keep it", () => {
    const input = request({ type: "text" }, "learning.batch", "ollama");
    const before = structuredClone(input);
    const payload = buildOllamaPayload(input);
    expect(payload).not.toHaveProperty("format");
    expect(payload.messages).toEqual(input.messages);
    expect(input).toEqual(before);
    expect(buildOllamaPayload(request(undefined, "learning.batch", "ollama")).format).toBe("json");
  });

  test("removes provider formatting and injected schema instructions for text", () => {
    expect(projectOpenAIResponsesFormat({ type: "text" })).toEqual({
      format: undefined,
      instructions: [],
      diagnostics: [],
    });
    expect(projectOllamaFormat({ type: "text" })).toEqual({
      format: undefined,
      diagnostics: [],
    });
  });

  test.each([projectOpenAIResponsesFormat, projectOllamaFormat])(
    "plain text does not bypass projection metadata validation",
    (project) => {
      expect(() =>
        project({ type: "text", postValidatedSchemaConstraints: [] }),
      ).toThrow(TypeError);
      expect(() =>
        project({ type: "text", postValidatedSchemaKeywords: [] }),
      ).toThrow(TypeError);
    },
  );
});


test.each(["openai", "ollama"] as const)("%s isolates explicit text instructions without changing profile tuning or ordinary calibration", provider => {
  const input = request({ type: "text", calibrationInstructions: "omit" }, "learning.batch", provider);
  input.modelPolicy!.profiles!.fixture!.calibration!["learning.batch"] = {
    format: "json", instructions: ["JSON_CALIBRATION_ONLY"], generation: { temperature: 0.25 },
  };
  const before = structuredClone(input);
  const invocation = resolveModelInvocation(input);
  expect(invocation.instructions).toBeUndefined();
  expect(invocation.profile.generation.temperature).toBe(0.25);
  const builders = provider === "openai" ? [buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload] : [buildOllamaPayload];
  for (const build of builders) {
    const payload = build(input);
    expect(JSON.stringify(payload)).not.toContain("JSON_CALIBRATION_ONLY");
    expect(JSON.stringify(payload)).not.toContain("calibrationInstructions");
    for (const format of [undefined, { type: "text" }, "json"]) {
      const ordinary = build({ ...input, format });
      expect(JSON.stringify(ordinary)).toContain("JSON_CALIBRATION_ONLY");
    }
  }
  expect(input).toEqual(before);
});
