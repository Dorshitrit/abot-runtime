import { expect, test } from "vitest";
import { buildModelConfig } from "../../../scripts/runtime-setup-files.js";

test("OpenAI setup budgets raw payload authoring without changing template controls or other steps", () => {
  const template = {
    generation: { reasoningEffort: "high" },
    calibration: {
      "toolPayload.raw": {
        instructions: ["Produce only the selected payload."],
        generation: { maxOutputTokens: 8192 },
      },
      "execution.decision": { format: "json", timeoutMs: 45_000 },
    },
  };
  const original = structuredClone(template);
  const profile = buildModelConfig(template, "openai", "fixture-model");

  expect(profile.calibration).toEqual({
    ...template.calibration,
    "context.compact": { timeoutMs: 300_000 },
    "toolPayload.raw": {
      ...template.calibration["toolPayload.raw"],
      timeoutMs: 300_000,
    },
  });
  expect(profile.generation).toEqual(template.generation);
  expect(template).toEqual(original);
});

test.each([45_000, 600_000])(
  "OpenAI setup preserves an explicitly calibrated raw payload timeout of %s",
  (timeoutMs) => {
    const calibration = {
      "toolPayload.raw": {
        timeoutMs,
        instructions: ["Keep this profile's literal-payload controls."],
      },
    };
    expect(
      buildModelConfig({ calibration }, "openai", "fixture-model").calibration,
    ).toEqual({
      ...calibration,
      "context.compact": { timeoutMs: 300_000 },
    });
  },
);

test.each(["ollama", "llamacpp", "future-adapter"])(
  "%s setup leaves raw payload timeout policy unchanged",
  (provider) => {
    const missingSlot = buildModelConfig({}, provider, "fixture-model");
    expect(
      (missingSlot.calibration as Record<string, unknown> | undefined)?.["toolPayload.raw"],
    ).toBeUndefined();

    const calibration = {
      "toolPayload.raw": { timeoutMs: 120_000, generation: { temperature: 0 } },
    };
    expect(
      buildModelConfig({ calibration }, provider, "fixture-model").calibration,
    ).toMatchObject(calibration);
  },
);
