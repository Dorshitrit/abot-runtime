import { describe, expect, test, vi } from "vitest";
import type { RuntimeSetupInput } from "../../web-ui/app/components/runtime-setup-guide.js";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";

type Provider = "openai" | "ollama";
function savedSetup(provider: Provider, model = "chat-model") {
  return {
    ...setupSnapshot,
    configExists: true,
    editableConnection: { revision: "saved-connection" },
    existingModel: {
      provider,
      model,
      contextWindowTokens: 32768,
      ...(provider === "ollama" ? { baseUrl: "http://127.0.0.1:11434" } : {}),
    },
  };
}
function providerHarness(
  providers: Provider[],
  overrides: Parameters<typeof createGuideHarness>[0] = {},
) {
  const saveSetup = vi.fn(async (input: RuntimeSetupInput) => ({
    setup: {
      ...savedSetup(input.provider as Provider, input.model),
      existingModel: {
        provider: input.provider,
        model: input.model,
        contextWindowTokens: input.contextWindowTokens,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      },
    },
    activation: { status: "restart_required" as const },
  }));
  const harness = createGuideHarness({
    saveSetup,
    loadEmbeddingStatus: async () => ({
      status: {
        enabled: false,
        providers: providers.map((id) => ({ id, type: id })),
      },
    }),
    ...overrides,
  });
  return { ...harness, saveConnection: saveSetup };
}
function selectedEmbeddingProvider(
  harness: ReturnType<typeof createGuideHarness>,
) {
  return harness.container.innerHTML.match(
    /<option value="([^"]+)" selected>/,
  )?.[1];
}
async function connect(
  harness: ReturnType<typeof createGuideHarness>,
  provider: Provider,
) {
  await harness.open();
  harness.changeProvider(provider);
  harness.submit();
  harness.inputModel("chat-model");
  if (provider === "openai") harness.inputKey("fixture-key");
  harness.submit();
  await harness.ready();
}

describe("embedding default follows the onboarding connection", () => {
  test.each([
    ["openai", ["ollama", "openai"]],
    ["ollama", ["openai", "ollama"]],
  ] as Array<[Provider, Provider[]]>)(
    "selects the saved %s connection even when it is second in the catalog",
    async (provider, providers) => {
      const harness = providerHarness(providers);
      await connect(harness, provider);
      expect(harness.container.innerHTML).toContain("Add embedding");
      expect(selectedEmbeddingProvider(harness)).toBe(provider);
      expect(harness.saveEmbedding).not.toHaveBeenCalled();
    },
  );

  test("Back to Connection and changing provider resets the automatic embedding provider and old model", async () => {
    const harness = providerHarness(["ollama", "openai"]);
    await connect(harness, "ollama");
    expect(selectedEmbeddingProvider(harness)).toBe("ollama");
    harness.inputEmbeddingModel("old-ollama-embedding");
    harness.click("back");
    harness.click("back");
    harness.changeProvider("openai");
    harness.submit();
    harness.inputModel("cloud-chat-model");
    harness.inputKey("fixture-cloud-key");
    harness.submit();
    await harness.ready();
    expect(harness.saveConnection).toHaveBeenCalledTimes(2);
    expect(selectedEmbeddingProvider(harness)).toBe("openai");
    expect(harness.fields["embedding-model"].value).toBe("");
    expect(harness.saveEmbedding).not.toHaveBeenCalled();
  });

  test("same-provider address and model corrections preserve a manually selected alternate embedding", async () => {
    const harness = providerHarness(["ollama", "openai"]);
    await connect(harness, "ollama");
    harness.changeEmbeddingProvider("openai");
    harness.inputEmbeddingModel("manual-cloud-embedding");
    harness.click("back");
    harness.inputBaseUrl("http://corrected-ollama:11434");
    harness.inputModel("corrected-chat-model");
    harness.submit();
    await harness.ready();
    expect(harness.saveConnection.mock.calls[1][0]).toMatchObject({
      provider: "ollama",
      baseUrl: "http://corrected-ollama:11434",
      model: "corrected-chat-model",
    });
    expect(selectedEmbeddingProvider(harness)).toBe("openai");
    expect(harness.fields["embedding-model"].value).toBe(
      "manual-cloud-embedding",
    );
    expect(harness.saveEmbedding).not.toHaveBeenCalled();
  });

  test("same-provider correction retains a pending new embedding provider when its option remains available", async () => {
    const harness = providerHarness(["ollama"]);
    await connect(harness, "ollama");
    harness.changeEmbeddingProvider("new:openai");
    harness.inputEmbeddingModel("pending-cloud-embedding");
    harness.click("back");
    harness.inputBaseUrl("http://corrected-ollama:11434");
    harness.submit();
    await harness.ready();
    expect(selectedEmbeddingProvider(harness)).toBe("new:openai");
    expect(harness.fields["embedding-model"].value).toBe(
      "pending-cloud-embedding",
    );
    expect(harness.saveEmbedding).not.toHaveBeenCalled();
  });

  test("initial resume keeps already configured memory on a different provider", async () => {
    const harness = providerHarness(["openai", "ollama"], {
      loadSetup: async () => ({ setup: savedSetup("openai") }),
      loadEmbeddingStatus: async () => ({
        status: {
          enabled: true,
          providerId: "ollama",
          model: "existing-memory-model",
          providers: [
            { id: "openai", type: "openai" },
            { id: "ollama", type: "ollama" },
          ],
        },
      }),
    });
    await harness.open();
    harness.submit();
    await harness.ready();
    expect(selectedEmbeddingProvider(harness)).toBe("ollama");
    expect(harness.fields["embedding-model"].value).toBe(
      "existing-memory-model",
    );
    expect(harness.saveConnection).not.toHaveBeenCalled();
    expect(harness.saveEmbedding).not.toHaveBeenCalled();
  });
});
