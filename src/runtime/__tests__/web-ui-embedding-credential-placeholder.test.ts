import { describe, expect, test, vi } from "vitest";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";

function credentialHarness(credentialConfigured?: boolean) {
  const requests: Record<string, unknown>[] = [];
  const harness = createGuideHarness({
    loadSetup: async () => ({
      setup: {
        ...setupSnapshot,
        status: "ready",
        existingModel: { provider: "openai", model: "chat-model" },
      },
    }),
    loadEmbeddingStatus: async () => ({
      status: {
        enabled: false,
        providers: [
          { id: "cloud", type: "openai", credentialConfigured },
          { id: "other-cloud", type: "openai", credentialConfigured: false },
        ],
      },
    }),
    saveEmbedding: vi.fn(async (input) => {
      requests.push({ ...input });
      throw new Error("Embedding probe unavailable");
    }),
  });
  const keyMarkup = () =>
    harness.container.innerHTML.match(
      /<input\b[^>]*data-runtime-setup-field="embedding-key"[^>]*>/u,
    )?.[0];
  return { ...harness, requests, keyMarkup };
}

describe("embedding saved credential placeholder", () => {
  test.each([true, false, undefined])(
    "shows a mask only for an explicitly configured credential (%s)",
    async (configured) => {
      const harness = credentialHarness(configured);
      await harness.open();
      expect(harness.keyMarkup()?.includes('placeholder="••••••••"')).toBe(
        configured === true,
      );
      expect(harness.fields["embedding-key"].value).toBe("");
      harness.inputEmbeddingModel("embedding-model");
      harness.submit();
      await harness.ready();
      expect(harness.requests).toEqual([
        { providerId: "cloud", model: "embedding-model" },
      ]);
      expect(harness.fields["embedding-key"].value).toBe("");
    },
  );

  test("removes the saved-key mask when another or new connection is chosen", async () => {
    const harness = credentialHarness(true);
    await harness.open();
    expect(harness.keyMarkup()).toContain('placeholder="••••••••"');
    harness.changeEmbeddingProvider("other-cloud");
    expect(harness.keyMarkup()).not.toContain('placeholder="••••••••"');
    harness.changeEmbeddingProvider("new:openai");
    expect(harness.keyMarkup()).not.toContain('placeholder="••••••••"');
    harness.changeEmbeddingProvider("cloud");
    expect(harness.keyMarkup()).toContain('placeholder="••••••••"');
  });

  test("submits an explicitly entered replacement key while keeping it out of rendered markup", async () => {
    const harness = credentialHarness(true);
    await harness.open();
    harness.inputEmbeddingModel("embedding-model");
    harness.inputEmbeddingKey("synthetic-replacement-key");
    harness.submit();
    await harness.ready();
    expect(harness.requests[0]).toEqual({
      providerId: "cloud",
      model: "embedding-model",
      apiKey: "synthetic-replacement-key",
    });
    expect(harness.container.innerHTML).not.toContain(
      "synthetic-replacement-key",
    );
    expect(harness.fields["embedding-key"].value).toBe("");
  });

  test("uses verified credential metadata from a partial provider-save receipt", async () => {
    const harness = createGuideHarness({
      loadSetup: async () => ({
        setup: {
          ...setupSnapshot,
          status: "ready",
          existingModel: { provider: "ollama", model: "chat-model" },
        },
      }),
      saveEmbedding: async () => {
        throw Object.assign(new Error("probe failed"), {
          payload: {
            providerSaved: true,
            savedProvider: {
              id: "new-cloud",
              type: "openai",
              credentialConfigured: true,
            },
          },
        });
      },
    });
    await harness.open();
    harness.changeEmbeddingProvider("new:openai");
    harness.inputEmbeddingModel("embedding-model");
    harness.submit();
    await harness.ready();
    expect(harness.container.innerHTML).toContain('value="new-cloud" selected');
    expect(harness.container.innerHTML).toContain('placeholder="••••••••"');
    expect(harness.fields["embedding-key"].value).toBe("");
  });
});
