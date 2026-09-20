import { describe, expect, test } from "vitest";
import {
  buildRuntimeSetupCommands,
  validateRuntimeSetupModelId,
  validateRuntimeSetupBaseUrl,
} from "../../web-ui/app/components/runtime-setup-guide.js";

describe("legacy runtime setup commands", () => {
  test.each(["gemma3:4b", "gpt-5.6-luna"])(
    "preserves the source CLI argument contract for %s",
    (model) => {
      expect(buildRuntimeSetupCommands("ollama", model).setup).toBe(
        `npm run init -- --provider ollama --model ${model} --base-url http://127.0.0.1:11434`,
      );
    },
  );
  test("preserves the packaged CLI flow", () => {
    expect(
      buildRuntimeSetupCommands("openai", "gpt-5.6-luna", undefined, "package"),
    ).toMatchObject({
      setup: "npx abot init --provider openai --model gpt-5.6-luna",
      "model-gateway": "npx abot start",
      "web-ui": "",
    });
  });
  test.each([
    "gemma 3",
    "gemma'3",
    'gemma"3',
    "gemma&3",
    "gemma%3",
    "@scope/model",
    ",gemma3",
    "gemma,3",
    "--help",
  ])("rejects unsafe model ID %s", (model) => {
    expect(validateRuntimeSetupModelId(model).valid).toBe(false);
    expect(buildRuntimeSetupCommands("ollama", model).setup).toContain(
      "--model <model-id>",
    );
  });
  test.each([
    "http://localhost:11434/api/tags",
    "https://user:pass@example.com",
    "https://example.com?query=1",
    "file:///tmp",
  ])("rejects a non-origin server address %s", (address) => {
    expect(validateRuntimeSetupBaseUrl(address).valid).toBe(false);
  });
});
