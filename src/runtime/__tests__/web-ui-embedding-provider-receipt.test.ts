import { describe, expect, test, vi } from "vitest";
import type { SetupEmbeddingInput } from "../../web-ui/local-runtime/setup-embedding-input.js";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";

const savedProvider = { id: "openai-3", type: "openai" };
const savedSetup = {
  ...setupSnapshot,
  status: "ready" as const,
  existingModel: { provider: "ollama" as const, model: "chat-model" },
};

function failure(payload: Record<string, unknown> = {}) {
  return Object.assign(new Error("private-provider-response"), {
    payload: {
      providerSaved: true,
      savedProvider,
      message: "The embedding probe failed. Choose another model and retry.",
      ...payload,
    },
  });
}

function resumed(overrides: Parameters<typeof createGuideHarness>[0] = {}) {
  const loadEmbeddingStatus = vi.fn(async () => ({
    status: { enabled: false, providers: [{ id: "openai", type: "ollama" }] },
  }));
  const harness = createGuideHarness({
    loadSetup: async () => ({ setup: savedSetup }),
    loadEmbeddingStatus,
    ...overrides,
  });
  return { ...harness, loadEmbeddingStatus };
}

async function submitNewEmbedding(harness: ReturnType<typeof resumed>) {
  await harness.open();
  harness.changeEmbeddingProvider("new:openai");
  harness.inputEmbeddingModel("embedding-model");
  harness.inputEmbeddingKey("synthetic-private-key");
  harness.submit();
}

function success(providerId = savedProvider.id) {
  return {
    status: {
      enabled: true,
      providerId,
      model: "embedding-model",
      providers: [
        { id: "openai", type: "ollama" },
        { id: providerId, type: "openai" },
      ],
    },
  };
}

describe("embedding partial provider-save receipts", () => {
  test("a failed save selects the persisted identity and retries without creating another provider or retaining its key", async () => {
    const requests: SetupEmbeddingInput[] = [];
    const references: SetupEmbeddingInput[] = [];
    const saveEmbedding = vi.fn(async (input: SetupEmbeddingInput) => {
      requests.push({ ...input });
      references.push(input);
      if (requests.length === 1) throw failure();
      return success();
    });
    const harness = resumed({ saveEmbedding });
    await submitNewEmbedding(harness);
    await harness.ready();
    expect(harness.container.innerHTML).toContain('value="openai-3" selected');
    expect(harness.container.innerHTML).toContain('value="embedding-model"');
    expect(harness.container.innerHTML).toContain("The embedding probe failed");
    expect(harness.container.innerHTML).not.toContain("synthetic-private-key");
    expect(harness.container.innerHTML).not.toContain(
      "private-provider-response",
    );
    expect(harness.fields["embedding-key"].value).toBe("");
    expect(references[0]).not.toHaveProperty("apiKey");
    expect(harness.loadEmbeddingStatus).toHaveBeenCalledOnce();
    harness.submit();
    await harness.ready();
    expect(requests).toEqual([
      {
        provider: "openai",
        model: "embedding-model",
        apiKey: "synthetic-private-key",
      },
      { providerId: "openai-3", model: "embedding-model" },
    ]);
    expect(harness.container.innerHTML).toContain("Choose your plugins");
    expect(harness.loadEmbeddingStatus).toHaveBeenCalledOnce();
  });

  test.each([
    undefined,
    null,
    [],
    "openai-3",
    { id: "", type: "openai" },
    { id: " ", type: "openai" },
    { id: 3, type: "openai" },
    { id: "openai-3" },
    { id: "openai-3", type: "ollama" },
    { id: " openai-3", type: "openai" },
  ])("ignores an absent or invalid receipt %j", async (receipt) => {
    const requests: SetupEmbeddingInput[] = [];
    const saveEmbedding = vi.fn(async (input: SetupEmbeddingInput) => {
      requests.push({ ...input });
      throw failure({ savedProvider: receipt });
    });
    const harness = resumed({ saveEmbedding });
    await submitNewEmbedding(harness);
    await harness.ready();
    expect(harness.container.innerHTML).toContain(
      'value="new:openai" selected',
    );
    expect(harness.fields["embedding-key"].value).toBe("");
    harness.submit();
    await harness.ready();
    expect(requests[1]).toEqual({
      provider: "openai",
      model: "embedding-model",
    });
  });

  test("requires completed provider persistence before adopting the receipt", async () => {
    const saveEmbedding = vi.fn(async () => {
      throw failure({ providerSaved: false });
    });
    const harness = resumed({ saveEmbedding });
    await submitNewEmbedding(harness);
    await harness.ready();
    expect(harness.container.innerHTML).toContain(
      'value="new:openai" selected',
    );
    expect(harness.container.innerHTML).not.toContain('value="openai-3"');
  });

  test("an explicit saved selection cannot be redirected to a different provider ID", async () => {
    const saveEmbedding = vi.fn(async () => {
      throw failure();
    });
    const harness = resumed({
      loadEmbeddingStatus: async () => ({
        status: {
          enabled: false,
          providers: [{ id: "chosen", type: "openai" }],
        },
      }),
      saveEmbedding,
    });
    await harness.open();
    harness.inputEmbeddingModel("embedding-model");
    harness.submit();
    await harness.ready();
    expect(harness.container.innerHTML).toContain('value="chosen" selected');
    expect(harness.container.innerHTML).not.toContain('value="openai-3"');
  });

  test("a matching receipt updates an existing option without duplicates and leaves later selection changes independent", async () => {
    const requests: SetupEmbeddingInput[] = [];
    const saveEmbedding = vi.fn(async (input: SetupEmbeddingInput) => {
      requests.push({ ...input });
      if (requests.length === 1) throw failure();
      return success("ollama");
    });
    const harness = resumed({
      loadEmbeddingStatus: async () => ({
        status: {
          enabled: false,
          providers: [
            { id: "openai-3", type: "openai" },
            { id: "ollama", type: "ollama" },
          ],
        },
      }),
      saveEmbedding,
    });
    await harness.open();
    harness.inputEmbeddingModel("embedding-model");
    harness.submit();
    await harness.ready();
    expect(
      harness.container.innerHTML.match(/<option value="openai-3"/g),
    ).toHaveLength(1);
    harness.changeEmbeddingProvider("ollama");
    harness.submit();
    await harness.ready();
    expect(requests[1]).toEqual({
      providerId: "ollama",
      model: "embedding-model",
    });
  });

  test.each(["reset", "environment"] as const)(
    "a stale receipt cannot replace the selection after %s changes",
    async (change) => {
      let rejectPending!: (error: Error) => void;
      let environment = "prod";
      const saveEmbedding = vi.fn(
        () =>
          new Promise<Record<string, unknown>>((_resolve, reject) => {
            rejectPending = reject;
          }),
      );
      const harness = resumed({
        saveEmbedding,
        getEnvironmentId: () => environment,
      });
      await submitNewEmbedding(harness);
      if (change === "environment") environment = "dev";
      else harness.guide.dispose();
      harness.guide.render({ status: "setup_required" });
      rejectPending(failure());
      await harness.ready();
      expect(harness.container.innerHTML).not.toContain('value="openai-3"');
      expect(harness.container.innerHTML).not.toContain(
        "The embedding probe failed",
      );
      expect(harness.container.innerHTML).not.toContain(
        "synthetic-private-key",
      );
      expect(harness.fields["embedding-key"].value).toBe("");
    },
  );
});
