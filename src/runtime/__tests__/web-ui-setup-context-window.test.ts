import { describe, expect, test } from "vitest";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";
import {
  createModelWizardHarness,
  modelSetupCatalog,
} from "./support/model-setup-wizard-harness.js";

const invalidWindows = ["", "0", "-1", "1.5", "9007199254740992", "Infinity"];

describe("model context window in setup", () => {
  test("shows the canonical default and saves an edited onboarding value in the Ready summary", async () => {
    const harness = createGuideHarness({
      loadSetup: async () => ({
        setup: { ...setupSnapshot, defaultContextWindowTokens: 65536 },
      }),
    });
    await harness.open();
    harness.changeProvider("ollama");
    harness.submit();
    expect(harness.fields["context-window"].value).toBe("65536");
    harness.inputModel("test-model");
    harness.inputContextWindow("131072");
    harness.click("back");
    harness.submit();
    expect(harness.fields["context-window"].value).toBe("131072");
    harness.submit();
    await harness.ready();
    expect(harness.submissions[0]).toMatchObject({
      contextWindowTokens: 131072,
    });
    expect(harness.saveEmbedding).not.toHaveBeenCalled();
    await harness.skipToReview();
    expect(harness.container.innerHTML).toContain("131,072 tokens");
    expect(harness.applySetup).not.toHaveBeenCalled();
  });

  test.each(invalidWindows)(
    "rejects onboarding context window %j before saving",
    async (value) => {
      const harness = createGuideHarness();
      await harness.open();
      harness.changeProvider("ollama");
      harness.submit();
      harness.inputModel("test-model");
      harness.inputContextWindow(value);
      harness.submit();
      expect(harness.saveSetup).not.toHaveBeenCalled();
      expect(
        harness.fields["context-window"].setAttribute,
      ).toHaveBeenCalledWith("aria-invalid", "true");
      expect(harness.fields["context-window"].focus).toHaveBeenCalled();
    },
  );

  test("preserves the existing context window during credential completion", async () => {
    const harness = createGuideHarness({
      loadSetup: async () => ({
        setup: {
          ...setupSnapshot,
          existingModel: {
            provider: "openai",
            model: "existing-model",
            contextWindowTokens: 131072,
          },
        },
      }),
    });
    await harness.open();
    expect(harness.fields["context-window"].value).toBe("131072");
    expect(harness.container.innerHTML).toMatch(
      /data-runtime-setup-field="context-window"[^>]*readonly/,
    );
    harness.inputContextWindow("2048");
    harness.inputKey("synthetic-secret");
    harness.submit();
    await harness.ready();
    expect(harness.submissions[0]).toMatchObject({
      contextWindowTokens: 131072,
    });
    expect(harness.fields["api-key"].value).toBe("");
  });

  test("uses catalog defaults in Add model and retains an edit through Ready and Back until final save", async () => {
    const harness = createModelWizardHarness({
      loadSetup: async () => ({
        ...modelSetupCatalog,
        defaultContextWindowTokens: 65536,
      }),
    });
    await harness.wizard.open({ providerId: "local" });
    expect(harness.field("context-window")?.value).toBe("65536");
    harness.input("model-id", "test-model");
    harness.input("context-window", "131072");
    harness.click("next");
    expect(
      harness.dialog.querySelector("[data-model-review]")?.textContent,
    ).toContain("131,072 tokens");
    expect(harness.dependencies.saveModel).not.toHaveBeenCalled();
    harness.click("back");
    expect(harness.field("context-window")?.value).toBe("131072");
    harness.click("next");
    harness.click("finish");
    await harness.settled();
    expect(harness.requests[0]).toEqual({
      profileId: "test-model",
      model: "test-model",
      providerId: "local",
      contextWindowTokens: 131072,
    });
    expect(harness.dependencies.applySetup).toHaveBeenCalledOnce();
  });

  test.each(invalidWindows)(
    "rejects Add model context window %j before Ready or saving",
    async (value) => {
      const harness = createModelWizardHarness();
      await harness.wizard.open({ providerId: "local" });
      harness.input("model-id", "test-model");
      harness.input("context-window", value);
      harness.click("next");
      expect(harness.dialog.querySelector("[data-model-form]")?.hidden).toBe(
        false,
      );
      expect(
        harness.field("context-window")?.attributes.get("aria-invalid"),
      ).toBe("true");
      expect(harness.dependencies.saveModel).not.toHaveBeenCalled();
    },
  );

  test("sends the same visible default when adding a new provider", async () => {
    const harness = createModelWizardHarness();
    await harness.wizard.open();
    harness.choose("new:ollama");
    harness.click("next");
    expect(harness.field("context-window")?.value).toBe("32768");
    harness.input("model-id", "test-model");
    harness.click("next");
    harness.click("finish");
    await harness.settled();
    expect(harness.requests[0]).toMatchObject({
      contextWindowTokens: 32768,
      newProvider: { type: "ollama" },
    });
  });
});
