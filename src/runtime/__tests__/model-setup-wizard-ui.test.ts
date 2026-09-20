import { describe, expect, test, vi } from "vitest";
import {
  createModelWizardHarness,
  modelSetupCatalog,
} from "./support/model-setup-wizard-harness.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function reviewExisting(
  harness: ReturnType<typeof createModelWizardHarness>,
  providerId = "local",
) {
  await harness.wizard.open({ providerId });
  harness.input("model-id", "new-model");
  harness.click("next");
}

describe("add model wizard", () => {
  test("preselects an existing provider and keeps the form node and key outside the review state until final save", async () => {
    const pending = deferred<any>();
    const requests: any[] = [];
    let requestReference: any;
    const saveModel = vi.fn((input) => {
      requestReference = input;
      requests.push({ ...input });
      return pending.promise;
    });
    const harness = createModelWizardHarness({
      loadSetup: async () => ({
        ...modelSetupCatalog,
        providers: modelSetupCatalog.providers.map((provider) => ({
          ...provider,
          credentialConfigured: false,
        })),
      }),
      saveModel,
    });
    await harness.wizard.open({ providerId: "cloud" });
    expect(harness.dialog.querySelector("[data-model-providers]")?.hidden).toBe(
      true,
    );
    harness.input("model-id", "gpt-test");
    harness.input("api-key", "synthetic-private-key");
    const form = harness.dialog.querySelector("[data-model-form]")!;
    const key = harness.field("api-key")!;
    harness.click("next");
    expect(harness.dialog.querySelector("[data-model-form]")).toBe(form);
    expect(form.hidden).toBe(true);
    expect(form.inert).toBe(true);
    expect(key.readCount).toBe(0);
    expect(harness.dialog.innerHTML).not.toContain("synthetic-private-key");
    expect(saveModel).not.toHaveBeenCalled();
    harness.click("back");
    expect(harness.field("api-key")).toBe(key);
    expect(form.hidden).toBe(false);
    harness.click("next");
    harness.click("finish");
    expect(key.readCount).toBe(1);
    expect(key.value).toBe("");
    expect(requests).toEqual([
      {
        profileId: "gpt-test",
        model: "gpt-test",
        providerId: "cloud",
        apiKey: "synthetic-private-key",
        contextWindowTokens: 32768,
      },
    ]);
    expect(harness.wizard.close()).toBe(false);
    harness.dialog.dispatch("cancel");
    expect(harness.wizard.isOpen()).toBe(true);
    pending.resolve({
      model: {
        profileId: "gpt-test",
        model: "gpt-test",
        providerId: "cloud",
        provider: "openai",
      },
      restartRequired: true,
    });
    await harness.settled();
    expect(requestReference).not.toHaveProperty("apiKey");
    expect(harness.wizard.isOpen()).toBe(false);
  });

  test("reuses configured credentials and closes only after applying, refreshing and releasing the lock", async () => {
    let harness!: ReturnType<typeof createModelWizardHarness>;
    const onComplete = vi.fn(async () => {
      expect(harness.isLocked()).toBe(true);
      expect(harness.wizard.isOpen()).toBe(true);
      return true;
    });
    const onClosed = vi.fn(({ completed }) => {
      expect(completed).toBe(true);
      expect(harness.isLocked()).toBe(false);
      expect(harness.wizard.isOpen()).toBe(false);
    });
    harness = createModelWizardHarness({ onComplete, onClosed });
    await reviewExisting(harness, "cloud");
    expect(harness.field("api-key")).toBeNull();
    expect(harness.field("ollama-base-url")).toBeNull();
    expect(harness.dependencies.saveModel).not.toHaveBeenCalled();
    harness.click("finish");
    await harness.settled();
    expect(harness.requests).toEqual([
      {
        profileId: "new-model",
        model: "new-model",
        providerId: "cloud",
        contextWindowTokens: 32768,
      },
    ]);
    expect(harness.dependencies.applySetup).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({
      profileId: "new-model",
      model: "new-model",
      providerId: "cloud",
      provider: "openai",
    });
    expect(onClosed).toHaveBeenCalledOnce();
  });

  test("validates unique editable connection and profile IDs before review without writing", async () => {
    const harness = createModelWizardHarness();
    await harness.wizard.open();
    harness.choose("new:ollama");
    harness.click("next");
    harness.input("model-id", "prototype");
    expect(harness.field("profile-id")?.value).toBe("model-prototype");
    harness.input("model-id", "existing-model");
    expect(harness.field("profile-id")?.value).toBe("existing-model-2");
    harness.input("connection-id", "local");
    harness.click("next");
    expect(harness.dialog.textContent).toContain(
      "That connection ID already exists",
    );
    harness.input("connection-id", "second-local");
    harness.input("profile-id", "existing-model");
    harness.click("next");
    expect(harness.dialog.textContent).toContain(
      "That model profile ID already exists",
    );
    harness.input("profile-id", "custom-profile");
    harness.input("ollama-base-url", "http://model-server:11434/");
    harness.click("next");
    expect(harness.dependencies.saveModel).not.toHaveBeenCalled();
    harness.click("finish");
    await harness.settled();
    expect(harness.requests).toEqual([
      {
        profileId: "custom-profile",
        contextWindowTokens: 32768,
        model: "existing-model",
        newProvider: {
          id: "second-local",
          type: "ollama",
          baseUrl: "http://model-server:11434",
        },
      },
    ]);
  });

  test.each(["existing:local", "new:ollama"])(
    "clears the old model and generated profile when changing %s to OpenAI",
    async (choice) => {
      const harness = createModelWizardHarness();
      await harness.wizard.open();
      harness.choose(choice);
      harness.click("next");
      harness.input("model-id", "gemma4:e4b-it-q4_K_M");
      expect(harness.field("profile-id")?.value).toBe("gemma4-e4b-it-q4_K_M");
      harness.click("back");
      harness.choose("existing:cloud");
      harness.click("next");
      expect(harness.field("model-id")?.value).toBe("");
      expect(harness.field("profile-id")?.value).toBe("");
      harness.click("next");
      harness.click("finish");
      expect(harness.dialog.querySelector("[data-model-form]")?.hidden).toBe(
        false,
      );
      expect(harness.dependencies.saveModel).not.toHaveBeenCalled();
    },
  );

  test("keeps the entered model and profile when Back retains the same provider", async () => {
    const harness = createModelWizardHarness();
    await harness.wizard.open({ providerId: "local" });
    harness.input("model-id", "gemma4:e4b-it-q4_K_M");
    harness.click("back");
    harness.choose("existing:local");
    harness.click("next");
    expect(harness.field("model-id")?.value).toBe("gemma4:e4b-it-q4_K_M");
    expect(harness.field("profile-id")?.value).toBe("gemma4-e4b-it-q4_K_M");
    expect(harness.dependencies.saveModel).not.toHaveBeenCalled();
  });

  test("preserves an explicit profile ID when changing providers and entering another model", async () => {
    const harness = createModelWizardHarness();
    await harness.wizard.open({ providerId: "local" });
    harness.input("model-id", "gemma4:e4b-it-q4_K_M");
    harness.input("profile-id", "my-selected-profile");
    harness.click("back");
    harness.choose("existing:cloud");
    harness.click("next");
    expect(harness.field("model-id")?.value).toBe("");
    expect(harness.field("profile-id")?.value).toBe("my-selected-profile");
    harness.input("model-id", "cloud-model");
    expect(harness.field("profile-id")?.value).toBe("my-selected-profile");
    harness.click("next");
    harness.click("finish");
    await harness.settled();
    expect(harness.requests).toEqual([
      {
        profileId: "my-selected-profile",
        model: "cloud-model",
        providerId: "cloud",
        contextWindowTokens: 32768,
      },
    ]);
  });

  test("clears a private key on provider change, Escape cancellation and disposal", async () => {
    const harness = createModelWizardHarness();
    await harness.wizard.open();
    harness.choose("new:openai");
    harness.click("next");
    harness.input("api-key", "first-secret");
    const firstKey = harness.field("api-key")!;
    harness.click("back");
    expect(firstKey.value).toBe("");
    harness.choose("new:ollama");
    harness.choose("new:openai");
    harness.click("next");
    harness.input("api-key", "second-secret");
    const secondKey = harness.field("api-key")!;
    harness.dialog.dispatch("cancel");
    expect(secondKey.value).toBe("");
    expect(harness.wizard.isOpen()).toBe(false);
    expect(harness.dependencies.saveModel).not.toHaveBeenCalled();
    expect(harness.dependencies.onClosed).toHaveBeenCalledWith({
      completed: false,
    });
    await harness.wizard.open();
    harness.choose("new:openai");
    harness.click("next");
    harness.input("api-key", "third-secret");
    const thirdKey = harness.field("api-key")!;
    harness.wizard.dispose();
    expect(thirdKey.value).toBe("");
    expect(harness.root.querySelector("dialog")).toBeNull();
    expect(harness.wizard.isOpen()).toBe(false);
  });

  test("retries applying the saved identity without another model write", async () => {
    const applySetup = vi
      .fn()
      .mockResolvedValueOnce({
        activation: {
          status: "restart_required",
          message: "The agent is working.",
        },
      })
      .mockResolvedValueOnce({ activation: { status: "ready" } });
    const harness = createModelWizardHarness({ applySetup });
    await reviewExisting(harness);
    harness.click("finish");
    await harness.settled();
    expect(harness.dialog.textContent).toContain("The agent is working.");
    expect(
      harness.dialog.querySelector('[data-model-action="back"]'),
    ).toBeNull();
    harness.click("finish");
    await harness.settled();
    expect(harness.dependencies.saveModel).toHaveBeenCalledOnce();
    expect(harness.dependencies.onSaved).toHaveBeenCalledOnce();
    expect(applySetup).toHaveBeenCalledTimes(2);
  });

  test("holds the configuration lock during refresh-only retry and never repeats save or apply", async () => {
    let harness!: ReturnType<typeof createModelWizardHarness>;
    const onComplete = vi.fn(async () => {
      expect(harness.isLocked()).toBe(true);
      return onComplete.mock.calls.length > 1;
    });
    harness = createModelWizardHarness({ onComplete });
    await reviewExisting(harness);
    harness.click("finish");
    await harness.settled();
    expect(harness.dialog.textContent).toContain("Refresh the model list");
    expect(harness.wizard.isOpen()).toBe(true);
    harness.click("finish");
    await harness.settled();
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.beginRuntimeMutation).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.endRuntimeMutation).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.saveModel).toHaveBeenCalledOnce();
    expect(harness.dependencies.applySetup).toHaveBeenCalledOnce();
    expect(harness.wizard.isOpen()).toBe(false);
  });

  test("reuses a privately saved credential after a partial write failure", async () => {
    const requests: any[] = [];
    const saveModel = vi.fn(async (input) => {
      requests.push({ ...input });
      if (requests.length === 1)
        throw {
          payload: {
            message: "The configuration changed. Try again.",
            credentialSaved: true,
          },
        };
      return {
        model: {
          profileId: input.profileId,
          model: input.model,
          providerId: input.newProvider.id,
          provider: "openai",
        },
        restartRequired: true,
      };
    });
    const harness = createModelWizardHarness({ saveModel });
    await harness.wizard.open();
    harness.choose("new:openai");
    harness.click("next");
    harness.input("model-id", "gpt-test");
    harness.input("api-key", "partial-secret");
    harness.click("next");
    harness.click("finish");
    await harness.settled();
    expect(harness.dialog.textContent).toContain("will be reused on retry");
    expect(harness.dialog.innerHTML).not.toContain("partial-secret");
    harness.click("finish");
    await harness.settled();
    expect(requests[0].apiKey).toBe("partial-secret");
    expect(requests[1]).not.toHaveProperty("apiKey");
    expect(harness.wizard.isOpen()).toBe(false);
  });

  test("discards stale metadata and save responses when the environment changes", async () => {
    let environment = "first";
    const loading = deferred<any>();
    const harness = createModelWizardHarness({
      getEnvironmentId: () => environment,
      loadSetup: () => loading.promise,
    });
    const opened = harness.wizard.open();
    environment = "second";
    loading.resolve(modelSetupCatalog);
    expect(await opened).toBe(false);
    expect(harness.wizard.isOpen()).toBe(false);
    const saving = deferred<any>();
    const next = createModelWizardHarness({
      getEnvironmentId: () => environment,
      saveModel: () => saving.promise,
    });
    await reviewExisting(next);
    next.click("finish");
    environment = "third";
    saving.resolve({
      model: {
        profileId: "new-model",
        model: "new-model",
        providerId: "local",
        provider: "ollama",
      },
    });
    await next.settled();
    expect(next.dependencies.onSaved).not.toHaveBeenCalled();
    expect(next.dependencies.applySetup).not.toHaveBeenCalled();
    expect(next.isLocked()).toBe(false);
    expect(next.wizard.isOpen()).toBe(false);
  });

  test("keeps failed metadata loads retryable and refuses writes when another configuration mutation is pending", async () => {
    const loadSetup = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(modelSetupCatalog);
    const harness = createModelWizardHarness({
      loadSetup,
      beginRuntimeMutation: () => false,
    });
    await harness.wizard.open();
    expect(harness.dialog.textContent).toContain(
      "Could not load provider connections",
    );
    harness.click("reload");
    await harness.settled();
    harness.choose("existing:local");
    harness.click("next");
    harness.input("model-id", "new-model");
    harness.click("next");
    harness.click("finish");
    expect(harness.dependencies.saveModel).not.toHaveBeenCalled();
    expect(harness.dialog.textContent).toContain(
      "Save or reset configuration changes",
    );
  });
});
