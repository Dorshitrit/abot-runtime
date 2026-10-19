import { expect, test } from "vitest";
import { buildModelConfig } from "../../../scripts/runtime-setup-files.js";

test("OpenAI setup adds a compaction budget while preserving calibration and its template", () => {
  const template = {
    generation: { reasoningEffort: "high" },
    calibration: {
      "execution.decision": { format: "json", timeoutMs: 45_000 },
      "context.compact": {
        format: "json",
        generation: { reasoningEffort: "high", maxOutputTokens: 8192 },
        instructions: ["Preserve the configured compaction policy."],
      },
    },
  };
  const original = structuredClone(template);
  const profile = buildModelConfig(template, "openai", "fixture-model");

  expect(profile.calibration).toEqual({
    ...template.calibration,
    "context.compact": {
      ...template.calibration["context.compact"],
      timeoutMs: 300_000,
    },
  });
  expect(profile.generation).toEqual(template.generation);
  expect(template).toEqual(original);
});

test.each([45_000, 600_000])(
  "OpenAI setup preserves an explicitly calibrated compaction timeout of %s",
  (timeoutMs) => {
    const calibration = {
      "context.compact": {
        timeoutMs,
        generation: { reasoningEffort: "high" },
      },
    };
    expect(
      buildModelConfig({ calibration }, "openai", "fixture-model").calibration,
    ).toEqual(calibration);
  },
);

test("other adapters retain their configured compaction budget", () => {
  const calibration = {
    "context.compact": { format: "json", timeoutMs: 120_000 },
  };
  expect(
    buildModelConfig({ calibration }, "future-adapter", "fixture-model")
      .calibration,
  ).toEqual(calibration);
  expect(
    buildModelConfig({ calibration }, "ollama", "fixture-model").calibration,
  ).toEqual({
    "context.compact": {
      ...calibration["context.compact"],
      generation: { temperature: 0, reasoningEffort: "none" },
    },
  });
});
