import { describe, expect, test, vi } from "vitest";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";

function savedSetup(revision = "draft-1") {
  return {
    ...setupSnapshot,
    status: "required" as const,
    configExists: true,
    editableConnection: { revision },
    existingModel: {
      provider: "ollama" as const,
      model: "chat-before",
      contextWindowTokens: 32768,
      baseUrl: "http://127.0.0.1:11434",
    },
  };
}

describe("editing an unfinished onboarding connection", () => {
  test("saves a corrected address after an embedding failure and reloads provider metadata", async () => {
    const saveSetup = vi.fn(async (input) => ({
      setup: {
        ...savedSetup("draft-2"),
        existingModel: {
          ...savedSetup().existingModel,
          baseUrl: input.baseUrl,
        },
      },
      activation: { status: "restart_required" as const },
    }));
    saveSetup.mockResolvedValueOnce({
      setup: savedSetup(),
      activation: { status: "restart_required" },
    });
    const saveEmbedding = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        status: {
          enabled: true,
          providerId: "ollama",
          model: "embedding-test",
        },
      });
    const harness = createGuideHarness({
      saveSetup,
      saveEmbedding,
    });
    await harness.open();
    harness.changeProvider("ollama");
    harness.submit();
    harness.inputModel("chat-before");
    harness.submit();
    await harness.ready();
    harness.inputEmbeddingModel("embedding-test");
    harness.submit();
    await harness.ready();
    expect(harness.container.innerHTML).toContain("Embedding check failed");
    harness.click("back");
    expect(harness.container.innerHTML).not.toContain("readonly");
    harness.inputBaseUrl("http://192.0.2.10:11434");
    harness.submit();
    await harness.ready();
    expect(saveSetup).toHaveBeenCalledTimes(2);
    expect(saveSetup.mock.calls[1][0]).toEqual({
      provider: "ollama",
      model: "chat-before",
      contextWindowTokens: 32768,
      baseUrl: "http://192.0.2.10:11434",
      connectionRevision: "draft-1",
      deferActivation: true,
    });
    expect(harness.loadEmbeddingStatus).toHaveBeenCalledTimes(2);
    expect(harness.fields["embedding-model"].value).toBe("embedding-test");
    expect(harness.container.innerHTML).not.toContain("Embedding check failed");
    harness.submit();
    await harness.ready();
    expect(saveEmbedding).toHaveBeenCalledTimes(2);
    expect(harness.container.innerHTML).toContain("Choose your plugins");
  });

  test("persists model and context edits and sends the latest revision on subsequent saves", async () => {
    const saveSetup = vi.fn(async (input) => ({
      setup: {
        ...savedSetup("draft-2"),
        existingModel: {
          provider: input.provider,
          model: input.model,
          contextWindowTokens: input.contextWindowTokens,
          baseUrl: input.baseUrl,
        },
      },
      activation: { status: "restart_required" as const },
    }));
    const harness = createGuideHarness({
      loadSetup: async () => ({ setup: savedSetup() }),
      saveSetup,
    });
    await harness.open();
    harness.inputModel("chat-after");
    harness.inputContextWindow("65536");
    harness.submit();
    await harness.ready();
    expect(saveSetup.mock.calls[0][0]).toMatchObject({
      model: "chat-after",
      contextWindowTokens: 65536,
      connectionRevision: "draft-1",
    });
    harness.click("back");
    harness.inputBaseUrl("http://192.0.2.10:11434");
    harness.submit();
    await harness.ready();
    expect(saveSetup.mock.calls[1][0]).toMatchObject({
      model: "chat-after",
      contextWindowTokens: 65536,
      connectionRevision: "draft-2",
    });
  });

  test("can go back to Provider, switch it, and save only the new provider fields", async () => {
    const saveSetup = vi.fn(async (input) => ({
      setup: {
        ...savedSetup("draft-2"),
        existingModel: {
          provider: input.provider,
          model: input.model,
          contextWindowTokens: input.contextWindowTokens,
        },
      },
      activation: { status: "restart_required" as const },
    }));
    const harness = createGuideHarness({
      loadSetup: async () => ({ setup: savedSetup() }),
      saveSetup,
    });
    await harness.open();
    harness.click("back");
    expect(harness.container.innerHTML).toContain(
      "Choose where your model runs",
    );
    harness.changeProvider("openai");
    harness.submit();
    harness.inputModel("new-chat-model");
    harness.inputKey("synthetic-key");
    harness.submit();
    await harness.ready();
    expect(saveSetup).toHaveBeenCalledExactlyOnceWith({
      provider: "openai",
      model: "new-chat-model",
      contextWindowTokens: 32768,
      apiKey: "synthetic-key",
      connectionRevision: "draft-1",
      deferActivation: true,
    });
    expect(harness.container.innerHTML).not.toContain("synthetic-key");
  });

  test("keeps pre-existing configuration locked when no editable draft is returned", async () => {
    const { editableConnection: _, ...establishedSetup } = savedSetup();
    const harness = createGuideHarness({
      loadSetup: async () => ({ setup: establishedSetup }),
    });
    await harness.open();
    expect(harness.container.innerHTML).toContain("readonly");
    harness.inputModel("should-not-replace");
    harness.inputContextWindow("65536");
    harness.inputBaseUrl("http://192.0.2.10:11434");
    harness.submit();
    await harness.ready();
    expect(harness.submissions[0]).toMatchObject({
      model: "chat-before",
      contextWindowTokens: 32768,
      baseUrl: "http://127.0.0.1:11434",
    });
  });

  test("keeps a failed correction editable and does not invalidate optional steps before a successful save", async () => {
    const saveSetup = vi.fn().mockRejectedValue(new Error("conflict"));
    const harness = createGuideHarness({
      loadSetup: async () => ({ setup: savedSetup() }),
      saveSetup,
    });
    await harness.open();
    harness.inputBaseUrl("http://192.0.2.10:11434");
    harness.submit();
    await harness.ready();
    expect(harness.container.innerHTML).toContain(
      "Could not save your connection",
    );
    expect(harness.container.innerHTML).not.toContain("readonly");
    expect(harness.fields["ollama-base-url"].value).toBe(
      "http://192.0.2.10:11434",
    );
    expect(harness.loadEmbeddingStatus).not.toHaveBeenCalled();
  });
});
