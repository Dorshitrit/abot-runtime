import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createEmbeddingSetupStep } from "../../web-ui/app/components/runtime-setup/embedding.js";
import type { SetupEmbeddingInput } from "../../web-ui/local-runtime/setup-embedding-input.js";
import { createGuideHarness, setupSnapshot } from "./support/runtime-setup-guide-harness.js";

const chatgptSetup = {
  ...setupSnapshot,
  status: "ready" as const,
  configExists: true,
  existingModel: { provider: "openai-chatgpt" as const, model: "chat-model", accountRef: "fixture-account" },
};
const unrelatedProviders = [{ id: "cloud", type: "openai" }, { id: "local", type: "ollama" }];
function chatgptGuide(overrides: Parameters<typeof createGuideHarness>[0] = {}) {
  return createGuideHarness({
    loadSetup: async () => ({ setup: chatgptSetup }),
    loadEmbeddingStatus: async () => ({ status: { enabled: false, providers: [] } }),
    ...overrides,
  });
}
function selectedProvider(markup: string) {
  return markup.match(/<option value="([^"]*)"[^>]*\sselected(?:\s|>)/)?.[1];
}
function embeddingStep(initialConnection: string, status: Record<string, unknown>) {
  let connection = initialConnection;
  const saveEmbedding = vi.fn(async () => ({}));
  const step = createEmbeddingSetupStep({
    container: { querySelector: () => null },
    getEnvironmentId: () => "prod",
    getPreferredProvider: () => connection,
    loadStatus: async () => ({ status }),
    discoverModels: vi.fn(async () => ({})),
    saveEmbedding,
    onChange: vi.fn(),
    onComplete: vi.fn(),
  });
  return { step, saveEmbedding, setConnection: (value: string) => { connection = value; } };
}

describe("ChatGPT onboarding requires a separate embedding choice", () => {
  test.each([{ providers: [] }, { providers: unrelatedProviders }])("leaves the provider unselected with catalog $providers and does not submit an empty choice", async ({ providers }) => {
    const h = chatgptGuide({
      loadEmbeddingStatus: async () => ({ status: { enabled: false, providers } }),
    });
    await h.open();
    expect(selectedProvider(h.container.innerHTML)).toBe("");
    expect(h.container.innerHTML).not.toContain('data-runtime-setup-field="embedding-key"');
    expect(h.container.innerHTML).toContain('value="new:llamacpp"');
    h.inputEmbeddingModel("embed-model");
    h.submit();
    await h.ready();
    expect(h.container.innerHTML).toContain('role="alert"');
    expect(h.saveEmbedding).not.toHaveBeenCalled();
    expect(h.discoverEmbeddingModels).not.toHaveBeenCalled();
    expect(h.saveSetup).not.toHaveBeenCalled();
  });

  test.each([
    { choice: "new:ollama", address: "http://127.0.0.1:11434", provider: "ollama" },
    { choice: "new:llamacpp", address: "http://127.0.0.1:8080", provider: "llamacpp" },
  ])("saves the explicitly selected $provider connection without an API key", async ({ choice, address, provider }) => {
    const requests: SetupEmbeddingInput[] = [];
    const h = chatgptGuide({
      saveEmbedding: async (input) => {
        requests.push({ ...input });
        return { status: {
          enabled: true, providerId: input.newProviderId || provider,
          model: input.model, providers: [{ id: input.newProviderId || provider, type: provider }],
        } };
      },
    });
    await h.open();
    h.changeEmbeddingProvider(choice);
    expect(selectedProvider(h.container.innerHTML)).toBe(choice);
    h.inputEmbeddingModel("embed-model");
    h.submit();
    await h.ready();
    expect(requests).toEqual([{
      provider, model: "embed-model", baseUrl: address,
      ...(provider === "llamacpp" ? { newProviderId: "llamacpp-embedding", useApiKey: false } : {}),
    }]);
    expect(h.container.innerHTML).toContain("Choose your plugins");
    expect(h.saveSetup).not.toHaveBeenCalled();
    expect(h.applySetup).not.toHaveBeenCalled();
  });

  test("keeps a saved embedding binding on resume and continues without probing it again", async () => {
    const h = chatgptGuide({
      loadEmbeddingStatus: async () => ({ status: {
        enabled: true, providerId: "local", model: "saved-embedding", providers: unrelatedProviders,
      } }),
    });
    await h.open();
    expect(selectedProvider(h.container.innerHTML)).toBe("local");
    expect(h.fields["embedding-model"].value).toBe("saved-embedding");
    h.submit();
    await h.ready();
    expect(h.saveEmbedding).not.toHaveBeenCalled();
    expect(h.container.innerHTML).toContain("Choose your plugins");
  });

  test("skip leaves embedding and chat settings untouched even before choosing a provider", async () => {
    const h = chatgptGuide();
    await h.open();
    h.click("skip-embedding");
    await h.ready();
    expect(h.container.innerHTML).toContain("Choose your plugins");
    expect(h.saveEmbedding).not.toHaveBeenCalled();
    expect(h.discoverEmbeddingModels).not.toHaveBeenCalled();
    expect(h.saveSetup).not.toHaveBeenCalled();
    expect(h.applySetup).not.toHaveBeenCalled();
  });

  test("switching chat to ChatGPT clears an automatic unsaved embedding choice", async () => {
    const { step, setConnection, saveEmbedding } = embeddingStep("openai", {
      enabled: false, providers: unrelatedProviders,
    });
    await step.load();
    expect(step.state.provider).toBe("cloud");
    step.input("embedding-model", "previous-model");
    setConnection("openai-chatgpt");
    step.invalidateConnection();
    await step.load();
    expect(step.state.provider).toBe("");
    expect(step.state.model).toBe("");
    expect(saveEmbedding).not.toHaveBeenCalled();
  });

  test("switching chat to ChatGPT preserves a saved embedding binding", async () => {
    const { step, setConnection } = embeddingStep("openai", {
      enabled: true, providerId: "local", model: "saved-embedding", providers: unrelatedProviders,
    });
    await step.load();
    setConnection("openai-chatgpt");
    step.invalidateConnection();
    await step.load();
    expect(step.state.provider).toBe("local");
    expect(step.state.model).toBe("saved-embedding");
  });

  test.each(["new:ollama", "new:llamacpp"])("same ChatGPT connection corrections retain the manual %s choice", async (choice) => {
    const { step } = embeddingStep("openai-chatgpt", { enabled: false, providers: [] });
    await step.load();
    step.change("embedding-provider", choice);
    step.input("embedding-model", "selected-embedding");
    step.input("embedding-url", "http://selected-host:9000");
    const connectionId = step.state.newProviderId;
    step.invalidateConnection();
    await step.load();
    expect(step.state.provider).toBe(choice);
    expect(step.state.model).toBe("selected-embedding");
    expect(step.state.baseUrl).toBe("http://selected-host:9000");
    expect(step.state.newProviderId).toBe(connectionId);
  });
});
