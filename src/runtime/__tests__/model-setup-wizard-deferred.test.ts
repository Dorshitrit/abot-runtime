import { describe, expect, test, vi } from "vitest";
import { createModelWizardHarness } from "./support/model-setup-wizard-harness.js";

const deferredActivation = {
  activation: {
    status: "restart_required" as const,
    message: "Another process owns this runtime.",
  },
};

async function saveExisting(
  harness: ReturnType<typeof createModelWizardHarness>,
) {
  await harness.wizard.open({ providerId: "local" });
  harness.input("model-id", "new-model");
  harness.click("next");
  harness.click("finish");
  await harness.settled();
}

describe("saved models awaiting activation", () => {
  test("refreshes the saved declaration under lock and retries only Apply", async () => {
    let harness!: ReturnType<typeof createModelWizardHarness>;
    const onDeferred = vi.fn(async () => {
      expect(harness.isLocked()).toBe(true);
      expect(harness.wizard.isBusy()).toBe(true);
      expect(harness.wizard.close()).toBe(false);
      return true;
    });
    const applySetup = vi
      .fn()
      .mockResolvedValueOnce(deferredActivation)
      .mockResolvedValueOnce({ activation: { status: "ready" } });
    harness = createModelWizardHarness({ applySetup, onDeferred });
    await saveExisting(harness);

    expect(onDeferred).toHaveBeenCalledExactlyOnceWith({
      profileId: "new-model",
      providerId: "local",
      provider: "ollama",
      model: "new-model",
    });
    expect(harness.dependencies.onComplete).not.toHaveBeenCalled();
    const feedback = harness.dialog.querySelector("[data-model-feedback]")!;
    expect(feedback.attributes.get("role")).toBe("status");
    expect(feedback.textContent).toContain("Model saved");
    expect(feedback.textContent).toContain("not active yet");
    expect(feedback.textContent).toContain(
      deferredActivation.activation.message,
    );
    expect(
      harness.dialog.querySelector('[data-model-action="cancel"]')?.textContent,
    ).toBe("Close");
    expect(
      harness.dialog.querySelector('[data-model-action="finish"]')?.textContent,
    ).toBe("Apply model");
    expect(harness.isLocked()).toBe(false);

    harness.click("finish");
    await harness.settled();
    expect(harness.dependencies.saveModel).toHaveBeenCalledOnce();
    expect(harness.dependencies.onSaved).toHaveBeenCalledOnce();
    expect(onDeferred).toHaveBeenCalledOnce();
    expect(applySetup).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.onComplete).toHaveBeenCalledOnce();
    expect(harness.wizard.isOpen()).toBe(false);
  });

  test.each(["returned failure", "thrown failure"])(
    "reports a saved model and a list refresh problem after %s",
    async (failure) => {
      const onDeferred = vi.fn(async () => {
        if (failure === "thrown failure")
          throw { payload: { message: "Dashboard unavailable." } };
        return false;
      });
      const harness = createModelWizardHarness({
        applySetup: async () => deferredActivation,
        onDeferred,
      });
      await saveExisting(harness);

      const feedback = harness.dialog.querySelector("[data-model-feedback]")!;
      expect(feedback.attributes.get("role")).toBe("alert");
      expect(feedback.textContent).toContain("Model saved");
      expect(feedback.textContent).toContain("not active yet");
      expect(feedback.textContent).toContain("refresh the model list");
      expect(feedback.textContent).not.toContain("Could not save");
      expect(harness.dependencies.saveModel).toHaveBeenCalledOnce();
      expect(harness.dependencies.onComplete).not.toHaveBeenCalled();
      expect(harness.wizard.isOpen()).toBe(true);
      expect(harness.isLocked()).toBe(false);
    },
  );

  test("preserves the successful save when Apply returns an error detail", async () => {
    const onDeferred = vi.fn(async () => true);
    const harness = createModelWizardHarness({
      onDeferred,
      applySetup: async () => {
        throw { payload: { message: "Runtime connection unavailable." } };
      },
    });
    await saveExisting(harness);

    const feedback = harness.dialog.querySelector("[data-model-feedback]")!;
    expect(feedback.attributes.get("role")).toBe("alert");
    expect(feedback.textContent).toContain("Model saved");
    expect(feedback.textContent).toContain("Could not apply");
    expect(feedback.textContent).toContain("Runtime connection unavailable.");
    expect(onDeferred).not.toHaveBeenCalled();
    expect(harness.dependencies.onComplete).not.toHaveBeenCalled();
    expect(harness.dependencies.saveModel).toHaveBeenCalledOnce();
  });
});
