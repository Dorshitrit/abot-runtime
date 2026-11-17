import { expect, test } from "vitest";
import { buildModelConfig } from "../../../scripts/runtime-setup-files.js";

test.each(["llamacpp", "ollama"])("%s preserves explicit sampling without manufacturing defaults", provider => {
  const template = {
    generation: { topP: 0.9 },
    calibration: { "execution.decision": { generation: { temperature: 0.4 } } },
  };
  const original = structuredClone(template);
  const profile = buildModelConfig(template, provider, "local-model");

  expect(profile.generation).toEqual({ topP: 0.9 });
  expect(profile.calibration).toMatchObject(original.calibration);
  expect(template).toEqual(original);
});

test.each([
  ["llamacpp", 0], ["llamacpp", 0.65], ["ollama", 0], ["ollama", 0.65],
] as const)("%s preserves explicit temperature %s", (provider, temperature) => {
  const generation = { temperature, topP: 0.9 };
  expect(buildModelConfig({ generation }, provider, "local-model").generation).toEqual(generation);
});

test.each([0, 0.7])("Ollama retains native options.temperature %s", temperature => {
  const options = { temperature };
  const profile = buildModelConfig({ options }, "ollama", "local-model");

  expect(profile.options).toEqual(options);
  expect(profile).not.toHaveProperty("generation.temperature");
});

test.each(["llamacpp", "ollama", "openai", "openai-chatgpt", "future-adapter"])("%s leaves sampling to the configured provider", provider => {
  expect(buildModelConfig({}, provider, "model")).not.toHaveProperty("generation.temperature");
  const generation = { temperature: 0.6 };
  expect(buildModelConfig({ generation }, provider, "model").generation).toEqual(generation);
});
