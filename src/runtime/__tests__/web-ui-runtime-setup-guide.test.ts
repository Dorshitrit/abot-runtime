import { describe, expect, test, vi } from "vitest";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";
import { type RuntimeSetupInput } from "../../web-ui/app/components/runtime-setup-guide.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("runtime setup wizard", () => {
  test("moves one step at a time and preserves nonsensitive choices through Back", async () => {
    const harness = createGuideHarness();
    await harness.open();
    expect(harness.container.innerHTML).toContain('aria-current="step"');
    expect(harness.container.innerHTML).not.toContain('type="password"');
    harness.submit();
    expect(harness.container.innerHTML).not.toContain(
      'data-runtime-setup-field="model-id"',
    );
    harness.changeProvider("openai");
    harness.submit();
    expect(harness.container.innerHTML).toContain('type="password"');
    harness.inputModel("gpt-test");
    harness.inputKey("synthetic-secret");
    harness.click("back");
    expect(harness.fields["api-key"].value).toBe("");
    harness.submit();
    expect(harness.container.innerHTML).toContain('value="gpt-test"');
    expect(harness.container.innerHTML).not.toContain("synthetic-secret");
    expect(harness.title.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test("validates fields before submitting and associates the first invalid field", async () => {
    const harness = createGuideHarness();
    await harness.open();
    harness.changeProvider("openai");
    harness.submit();
    harness.submit();
    expect(harness.fields["model-id"].setAttribute).toHaveBeenCalledWith(
      "aria-invalid",
      "true",
    );
    expect(harness.saveSetup).not.toHaveBeenCalled();
    harness.inputModel("gpt-test");
    harness.submit();
    expect(harness.fields["api-key"].focus).toHaveBeenCalled();
    expect(harness.saveSetup).not.toHaveBeenCalled();
  });

  test("writes a key once, clears it immediately and refreshes models on completion", async () => {
    const pending = deferred<any>();
    const submissions: RuntimeSetupInput[] = [];
    const saveSetup = vi.fn((input: RuntimeSetupInput) => {
      submissions.push({ ...input });
      return pending.promise;
    });
    const harness = createGuideHarness({ saveSetup });
    await harness.open();
    const onCheckAgain = vi.fn();
    harness.guide.bind({ onCheckAgain });
    harness.changeProvider("openai");
    harness.submit();
    harness.inputModel("gpt-test");
    harness.inputKey("synthetic-secret");
    expect(harness.container.innerHTML).not.toContain("synthetic-secret");
    harness.submit();
    harness.submit();
    expect(saveSetup).toHaveBeenCalledOnce();
    expect(submissions).toEqual([
      {
        provider: "openai",
        model: "gpt-test",
        apiKey: "synthetic-secret",
        contextWindowTokens: 32768,
        deferActivation: true,
      },
    ]);
    expect(harness.fields["api-key"].value).toBe("");
    pending.resolve({ setup: setupSnapshot, activation: { status: "ready" } });
    await vi.waitFor(() =>
      expect(harness.container.innerHTML).toContain("Add embedding"),
    );
    expect(harness.container.innerHTML).not.toContain("synthetic-secret");
    await harness.skipToReview();
    harness.click("apply");
    await vi.waitFor(() => expect(onCheckAgain).toHaveBeenCalledOnce());
  });

  test("reuses configured OpenAI credentials without sending an empty replacement", async () => {
    const configured = {
      ...setupSnapshot,
      providers: setupSnapshot.providers.map((provider) => ({
        ...provider,
        credentialConfigured: true,
      })),
    };
    const harness = createGuideHarness({
      loadSetup: async () => ({ setup: configured }),
    });
    await harness.open();
    harness.changeProvider("openai");
    harness.submit();
    expect(harness.container.innerHTML).toContain("API key (optional)");
    harness.inputModel("gpt-test");
    harness.submit();
    await vi.waitFor(() => expect(harness.submissions).toHaveLength(1));
    expect(harness.submissions[0]).toEqual({
      provider: "openai",
      model: "gpt-test",
      contextWindowTokens: 32768,
      deferActivation: true,
    });
  });

  test("validates the Ollama origin and sends only the provider's fields", async () => {
    const harness = createGuideHarness();
    await harness.open();
    harness.changeProvider("ollama");
    harness.submit();
    expect(harness.container.innerHTML).not.toContain('type="password"');
    harness.inputModel("gemma3:4b");
    harness.inputBaseUrl("http://localhost:11434/api/tags");
    harness.submit();
    expect(harness.saveSetup).not.toHaveBeenCalled();
    expect(harness.fields["ollama-base-url"].focus).toHaveBeenCalled();
    harness.inputBaseUrl("http://localhost:11434/");
    harness.submit();
    await vi.waitFor(() => expect(harness.submissions).toHaveLength(1));
    expect(harness.submissions[0]).toEqual({
      provider: "ollama",
      model: "gemma3:4b",
      baseUrl: "http://localhost:11434",
      contextWindowTokens: 32768,
      deferActivation: true,
    });
  });

  test("keeps a failed save editable and never displays an echoed secret", async () => {
    const harness = createGuideHarness({
      saveSetup: async () => {
        throw new Error("synthetic-secret");
      },
    });
    await harness.open();
    harness.changeProvider("openai");
    harness.submit();
    harness.inputModel("gpt-test");
    harness.inputKey("synthetic-secret");
    harness.submit();
    await vi.waitFor(() =>
      expect(harness.container.innerHTML).toContain('role="alert"'),
    );
    expect(harness.container.innerHTML).toContain('value="gpt-test"');
    expect(harness.container.innerHTML).not.toContain("synthetic-secret");
    expect(harness.fields["api-key"].value).toBe("");
  });

  test("keeps setup incomplete until optional choices and final activation", async () => {
    const harness = createGuideHarness();
    await harness.open();
    harness.changeProvider("ollama");
    harness.submit();
    harness.inputModel("gemma3:4b");
    harness.submit();
    await harness.ready();
    expect(harness.container.innerHTML).toContain("Add embedding");
    expect(harness.container.innerHTML).not.toContain("Start chatting");
    expect(harness.applySetup).not.toHaveBeenCalled();
    await harness.skipToReview();
    expect(harness.container.innerHTML).toContain("Finish setup");
    expect(harness.applySetup).not.toHaveBeenCalled();
  });

  test("discards an in-flight save from a previous environment and clears secrets on disposal", async () => {
    let environmentId = "old";
    const pending = deferred<any>();
    const harness = createGuideHarness({
      getEnvironmentId: () => environmentId,
      saveSetup: () => pending.promise,
    });
    await harness.open();
    harness.changeProvider("openai");
    harness.submit();
    harness.inputModel("gpt-test");
    harness.inputKey("synthetic-secret");
    harness.submit();
    environmentId = "new";
    harness.guide.render({ status: "setup_required" });
    await harness.ready();
    pending.resolve({ setup: setupSnapshot, activation: { status: "ready" } });
    await Promise.resolve();
    expect(harness.container.innerHTML).not.toContain("Start chatting");
    expect(harness.container.innerHTML).not.toContain("gpt-test");
    harness.guide.dispose();
    expect(harness.fields["api-key"].value).toBe("");
    expect(harness.container.innerHTML).toBe("");
  });

  test("lets a failed metadata load retry explicitly", async () => {
    const loadSetup = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ setup: setupSnapshot });
    const harness = createGuideHarness({ loadSetup });
    await harness.open();
    expect(harness.container.innerHTML).toContain(
      'data-runtime-setup-action="reload"',
    );
    harness.click("reload");
    await harness.ready();
    expect(loadSetup).toHaveBeenCalledTimes(2);
    expect(harness.container.innerHTML).toContain('value="ollama"');
  });
  test("completes a missing credential without editing existing model configuration", async () => {
    const existing = {
      ...setupSnapshot,
      existingModel: { provider: "openai" as const, model: "existing-model" },
    };
    const harness = createGuideHarness({
      loadSetup: async () => ({ setup: existing }),
    });
    await harness.open();
    expect(harness.container.innerHTML).toContain('value="existing-model"');
    expect(harness.container.innerHTML).toContain("readonly");
    harness.changeProvider("ollama");
    harness.inputModel("replacement-model");
    harness.inputKey("synthetic-secret");
    harness.submit();
    await vi.waitFor(() => expect(harness.submissions).toHaveLength(1));
    expect(harness.submissions[0]).toEqual({
      provider: "openai",
      model: "existing-model",
      apiKey: "synthetic-secret",
      contextWindowTokens: 32768,
      deferActivation: true,
    });
  });
  test("retries actual application after a saved connection was blocked and never refreshes early", async () => {
    const applySetup = vi
      .fn()
      .mockResolvedValueOnce({
        activation: {
          status: "restart_required",
          message: "The agent is working.",
        },
      })
      .mockResolvedValueOnce({ activation: { status: "ready" } });
    const harness = createGuideHarness({
      applySetup,
      saveSetup: async () => ({
        setup: setupSnapshot,
        activation: { status: "restart_required" },
      }),
    });
    await harness.open();
    const onCheckAgain = vi.fn();
    harness.guide.bind({ onCheckAgain });
    harness.changeProvider("ollama");
    harness.submit();
    harness.inputModel("gemma3:4b");
    harness.inputBaseUrl("http://ollama-server:11434");
    harness.submit();
    await harness.skipToReview();
    harness.click("apply");
    await vi.waitFor(() =>
      expect(harness.container.innerHTML).toContain("The agent is working."),
    );
    expect(onCheckAgain).not.toHaveBeenCalled();
    harness.click("apply");
    await vi.waitFor(() => expect(onCheckAgain).toHaveBeenCalledOnce());
    expect(applySetup).toHaveBeenCalledTimes(2);
  });

  test("reloads saved configuration into optional steps without requesting the key again", async () => {
    const saved = {
      ...setupSnapshot,
      status: "ready" as const,
      existingModel: { provider: "openai" as const, model: "saved-model" },
    };
    const harness = createGuideHarness({
      loadSetup: async () => ({ setup: saved }),
    });
    await harness.open();
    expect(harness.container.innerHTML).toContain("Add embedding");
    await harness.skipToReview();
    expect(harness.container.innerHTML).toContain("saved-model");
    expect(harness.container.innerHTML).not.toContain('type="password"');
  });
});
