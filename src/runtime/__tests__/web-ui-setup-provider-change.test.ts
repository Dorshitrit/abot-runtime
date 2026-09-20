import { describe, expect, test } from "vitest";
import { createBridgeSetupGuide } from "../../web-ui/app/components/runtime-setup/bridge-guide.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
import { createGuideHarness } from "./support/runtime-setup-guide-harness.js";

const providerChanges = [
  ["ollama", "gemma4:e4b-it-q4_K_M", "openai"],
  ["openai", "gpt-test", "ollama"],
] as const;

describe("onboarding provider changes", () => {
  test.each(providerChanges)(
    "clears %s model %s when switching to %s",
    async (before, model, after) => {
      const harness = createGuideHarness();
      await harness.open();
      harness.changeProvider(before);
      harness.submit();
      harness.inputModel(model);
      harness.inputContextWindow("65536");
      harness.click("back");
      harness.changeProvider(after);
      harness.submit();
      expect(harness.fields["model-id"].value).toBe("");
      expect(harness.fields["context-window"].value).toBe("65536");
      expect(harness.container.innerHTML.includes('type="password"')).toBe(
        after === "openai",
      );
      harness.inputKey("synthetic-key");
      harness.submit();
      await harness.ready();
      expect(harness.saveSetup).not.toHaveBeenCalled();
      expect(harness.fields["model-id"].setAttribute).toHaveBeenCalledWith(
        "aria-invalid",
        "true",
      );
      harness.inputModel("replacement-model");
      harness.inputKey("synthetic-key");
      harness.submit();
      await harness.ready();
      expect(harness.submissions[0]).toMatchObject({
        provider: after,
        model: "replacement-model",
        contextWindowTokens: 65536,
      });
    },
  );

  test("returning to the same provider preserves the model and address", async () => {
    const harness = createGuideHarness();
    await harness.open();
    harness.changeProvider("ollama");
    harness.submit();
    harness.inputModel("gemma4:e4b-it-q4_K_M");
    harness.inputBaseUrl("http://192.0.2.10:11434");
    harness.click("back");
    harness.changeProvider("ollama");
    harness.submit();
    expect(harness.fields["model-id"].value).toBe("gemma4:e4b-it-q4_K_M");
    expect(harness.fields["ollama-base-url"].value).toBe(
      "http://192.0.2.10:11434",
    );
  });
});

function createBridgeHarness() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  document.activeElement = document.body;
  const container = document.createElement("section");
  document.body.append(container);
  const guide = createBridgeSetupGuide({
    container: container as never,
    conversationRegion: document.createElement("section") as never,
  });
  guide.bind();
  guide.render({ status: "setup_required", showGuide: true });
  const field = (name: string) =>
    container.querySelector(`[data-runtime-setup-field="${name}"]`)!;
  return {
    container,
    field,
    choose(provider: string) {
      container
        .querySelector(
          `[data-runtime-setup-field="provider"][value="${provider}"]`,
        )!
        .dispatch("change");
    },
    model(value: string) {
      field("model-id").value = value;
      field("model-id").dispatch("input");
    },
    submit: () => container.dispatch("submit"),
    back: () =>
      container
        .querySelector('[data-runtime-setup-action="back"]')!
        .dispatch("click"),
  };
}

describe("Bridge provider changes", () => {
  test.each(providerChanges)(
    "clears %s model %s before generating %s commands",
    (before, model, after) => {
      const harness = createBridgeHarness();
      harness.choose(before);
      harness.model(model);
      harness.submit();
      expect(
        harness.container.querySelector("[data-runtime-command]"),
      ).not.toBeNull();
      harness.back();
      harness.choose(after);
      expect(harness.field("model-id").value).toBe("");
      harness.submit();
      expect(
        harness.container.querySelector("[data-runtime-command]"),
      ).toBeNull();
      expect(harness.field("model-id").attributes.get("aria-invalid")).toBe(
        "true",
      );
      harness.model("replacement-model");
      harness.submit();
      expect(harness.container.textContent).toContain(`--provider ${after}`);
      expect(harness.container.textContent).toContain("replacement-model");
      expect(harness.container.textContent).not.toContain(model);
    },
  );

  test("returning to the same Bridge provider preserves its model", () => {
    const harness = createBridgeHarness();
    harness.choose("ollama");
    harness.model("gemma4:e4b-it-q4_K_M");
    harness.submit();
    harness.back();
    harness.choose("ollama");
    expect(harness.field("model-id").value).toBe("gemma4:e4b-it-q4_K_M");
  });
});
