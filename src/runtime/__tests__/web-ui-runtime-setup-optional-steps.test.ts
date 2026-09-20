import { describe, expect, test, vi } from "vitest";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";

const savedSetup = {
  ...setupSnapshot,
  status: "ready" as const,
  existingModel: { provider: "ollama" as const, model: "chat-model" },
};
const pluginSnapshot = {
  selection: { enabled: true, allow: ["*"], deny: [] },
  plugins: [
    {
      id: "filesystem",
      description: "Read and edit workspace files.",
      pluginEnabled: true,
      capabilityCount: 2,
      selectedCapabilityCount: 2,
      capabilities: [
        {
          id: "read_file",
          description: "Read a file.",
          enabled: true,
          blockedByPolicy: false,
        },
        {
          id: "edit_file",
          description: "Edit a file.",
          enabled: true,
          blockedByPolicy: false,
        },
      ],
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function resumed(overrides: Parameters<typeof createGuideHarness>[0] = {}) {
  return createGuideHarness({
    loadSetup: async () => ({ setup: savedSetup }),
    loadPlugins: async () => structuredClone(pluginSnapshot),
    ...overrides,
  });
}

async function openPlugins(harness: ReturnType<typeof createGuideHarness>) {
  await harness.open();
  harness.click("skip-embedding");
  await harness.ready();
}

function pluginInput(
  harness: ReturnType<typeof createGuideHarness>,
  capabilityId?: string,
) {
  return harness.container
    .querySelectorAll("[data-runtime-plugin-toggle]")
    .find((input) => input.dataset.runtimeCapability === capabilityId)!;
}

describe("optional onboarding steps", () => {
  test("skips embedding without discovery or writes, preserves canonical defaults and applies only at Finish", async () => {
    const harness = resumed();
    const onCheckAgain = vi.fn();
    await openPlugins(harness);
    harness.guide.bind({ onCheckAgain });
    expect(harness.container.innerHTML).toContain("Choose your plugins");
    expect(pluginInput(harness).checked).toBe(true);
    expect(pluginInput(harness, "read_file").checked).toBe(true);
    expect(harness.discoverEmbeddingModels).not.toHaveBeenCalled();
    expect(harness.saveEmbedding).not.toHaveBeenCalled();
    expect(harness.applySetup).not.toHaveBeenCalled();
    harness.submit();
    expect(harness.container.innerHTML).toContain("Set up later");
    expect(harness.container.innerHTML).toContain("1 enabled");
    harness.click("apply");
    await vi.waitFor(() => expect(onCheckAgain).toHaveBeenCalledOnce());
    expect(harness.applySetup).toHaveBeenCalledOnce();
  });

  test("uses a new provider for embedding, clears its key during the explicit probe and never applies early", async () => {
    const pending = deferred<any>();
    const requests: any[] = [];
    let requestReference: any;
    const saveEmbedding = vi.fn((input) => {
      requestReference = input;
      requests.push({ ...input });
      return pending.promise;
    });
    const harness = resumed({ saveEmbedding });
    await harness.open();
    harness.changeEmbeddingProvider("new:openai");
    harness.inputEmbeddingModel("embedding-model");
    harness.inputEmbeddingKey("synthetic-embedding-secret");
    harness.submit();
    harness.click("skip-embedding");
    expect(harness.container.innerHTML).toContain("Add embedding");
    expect(requests).toEqual([
      {
        provider: "openai",
        model: "embedding-model",
        apiKey: "synthetic-embedding-secret",
      },
    ]);
    expect(harness.fields["embedding-key"].value).toBe("");
    expect(harness.container.innerHTML).not.toContain(
      "synthetic-embedding-secret",
    );
    expect(harness.applySetup).not.toHaveBeenCalled();
    pending.resolve({
      status: {
        enabled: true,
        providerId: "openai",
        model: "embedding-model",
        providers: [{ id: "openai", type: "openai" }],
      },
    });
    await harness.ready();
    expect(harness.container.innerHTML).toContain("Choose your plugins");
    expect(requestReference).not.toHaveProperty("apiKey");
  });

  test("preserves a failed embedding model and safe partial-save feedback while allowing Skip", async () => {
    const saveEmbedding = vi.fn(async () => {
      throw Object.assign(new Error("synthetic-secret"), {
        payload: {
          message: "The model did not return embeddings.",
          providerSaved: true,
        },
      });
    });
    const harness = resumed({ saveEmbedding });
    await harness.open();
    harness.changeEmbeddingProvider("new:openai");
    harness.inputEmbeddingModel("wrong-model");
    harness.inputEmbeddingKey("synthetic-secret");
    harness.submit();
    await harness.ready();
    expect(harness.container.innerHTML).toContain(
      "The model did not return embeddings.",
    );
    expect(harness.container.innerHTML).toContain("memory is unchanged");
    expect(harness.container.innerHTML).toContain('value="wrong-model"');
    expect(harness.container.innerHTML).not.toContain("synthetic-secret");
    expect(harness.fields["embedding-key"].value).toBe("");
    harness.click("skip-embedding");
    await harness.ready();
    expect(harness.container.innerHTML).toContain("Choose your plugins");
  });

  test("keeps existing embedding settings without another probe, but submits a replacement key", async () => {
    const existingMemory = {
      enabled: true,
      providerId: "custom-openai",
      model: "saved-embedding",
      providers: [{ id: "custom-openai", type: "openai" }],
    };
    const requests: any[] = [];
    const saveEmbedding = vi.fn(async (input) => {
      requests.push({ ...input });
      return { status: existingMemory };
    });
    const harness = resumed({
      loadEmbeddingStatus: async () => ({ status: existingMemory }),
      saveEmbedding,
    });
    await harness.open();
    expect(harness.container.innerHTML).toContain('value="saved-embedding"');
    harness.inputEmbeddingKey("replacement-secret");
    harness.submit();
    await harness.ready();
    expect(requests).toEqual([
      {
        providerId: "custom-openai",
        model: "saved-embedding",
        apiKey: "replacement-secret",
      },
    ]);
    harness.click("back");
    harness.submit();
    await harness.ready();
    expect(saveEmbedding).toHaveBeenCalledOnce();
  });

  test("discovers only on demand and never chooses an embedding model automatically", async () => {
    const harness = resumed();
    await harness.open();
    expect(harness.discoverEmbeddingModels).not.toHaveBeenCalled();
    harness.click("embedding-discover");
    await harness.ready();
    expect(harness.discoverEmbeddingModels).toHaveBeenCalledWith("ollama");
    expect(harness.container.innerHTML).toContain(
      '<option value="embedding-test">',
    );
    expect(harness.fields["embedding-model"].value).toBe("");
    harness.submit();
    expect(harness.saveEmbedding).not.toHaveBeenCalled();
  });

  test("saves a visible child selection while preserving siblings, scroll and focus", async () => {
    const pending = deferred<any>();
    const setPlugin = vi.fn(() => pending.promise);
    const harness = resumed({ setPlugin });
    await openPlugins(harness);
    harness.container.scrollTop = 240;
    const input = pluginInput(harness, "read_file");
    input.checked = false;
    input.dispatch("change");
    expect(setPlugin).toHaveBeenCalledWith({
      pluginId: "filesystem",
      capabilityId: "read_file",
      enabled: false,
    });
    expect(harness.container.scrollTop).toBe(240);
    harness.submit();
    expect(harness.container.innerHTML).not.toContain("Ready to finish");
    const saved = structuredClone(pluginSnapshot);
    saved.plugins[0].capabilities[0].enabled = false;
    saved.plugins[0].selectedCapabilityCount = 1;
    pending.resolve(saved);
    await harness.ready();
    expect(pluginInput(harness, "read_file").checked).toBe(false);
    expect(pluginInput(harness, "edit_file").checked).toBe(true);
    expect(pluginInput(harness).checked).toBe(true);
    expect(pluginInput(harness, "read_file").focus).toHaveBeenCalledWith({
      preventScroll: true,
    });
    expect(harness.container.innerHTML).toContain(
      "It will take effect when you finish setup",
    );
    expect(harness.container.scrollTop).toBe(240);
    harness.submit();
    harness.click("back");
    expect(pluginInput(harness, "read_file").checked).toBe(false);
  });

  test("respects existing blocked children and resumes saved deselections without resetting defaults", async () => {
    const snapshot = structuredClone(pluginSnapshot);
    snapshot.plugins[0].capabilities[0] = {
      ...snapshot.plugins[0].capabilities[0],
      enabled: false,
      blockedByPolicy: true,
    };
    const harness = resumed({ loadPlugins: async () => snapshot });
    await openPlugins(harness);
    expect(pluginInput(harness, "read_file").disabled).toBe(true);
    pluginInput(harness, "read_file").dispatch("change");
    expect(harness.setPlugin).not.toHaveBeenCalled();
    expect(pluginInput(harness, "edit_file").checked).toBe(true);
  });

  test("recovers a failed selection save by reloading the confirmed snapshot", async () => {
    const loadPlugins = vi.fn(async () => structuredClone(pluginSnapshot));
    const harness = resumed({
      loadPlugins,
      setPlugin: async () => {
        throw new Error("offline");
      },
    });
    await openPlugins(harness);
    const input = pluginInput(harness, "read_file");
    input.checked = false;
    input.dispatch("change");
    await harness.ready();
    expect(harness.container.innerHTML).toContain("Reload selection");
    expect(pluginInput(harness, "read_file").checked).toBe(true);
    harness.submit();
    expect(harness.container.innerHTML).not.toContain("Ready to finish");
    harness.click("plugins-reload");
    await harness.ready();
    expect(loadPlugins).toHaveBeenCalledTimes(2);
    harness.submit();
    expect(harness.container.innerHTML).toContain("Ready to finish");
  });

  test("discards an in-flight embedding response after environment change", async () => {
    const pending = deferred<any>();
    let environmentId = "first";
    const harness = resumed({
      getEnvironmentId: () => environmentId,
      saveEmbedding: () => pending.promise,
    });
    await harness.open();
    harness.inputEmbeddingModel("old-model");
    harness.submit();
    environmentId = "second";
    harness.guide.render({ status: "setup_required" });
    await harness.ready();
    pending.resolve({ status: { enabled: true, model: "old-model" } });
    await Promise.resolve();
    expect(harness.container.innerHTML).toContain("Add embedding");
    expect(harness.container.innerHTML).not.toContain("old-model");
    expect(harness.container.innerHTML).not.toContain("Choose your plugins");
  });
  test("keeps a successful apply terminal when the catalog refresh fails", async () => {
    const harness = resumed();
    await openPlugins(harness);
    const onCheckAgain = vi
      .fn()
      .mockRejectedValueOnce(new Error("catalog offline"))
      .mockResolvedValueOnce(undefined);
    harness.guide.bind({ onCheckAgain });
    harness.submit();
    harness.click("apply");
    await harness.ready();
    expect(harness.container.innerHTML).toContain(
      "Connection applied. Check model availability again.",
    );
    expect(harness.container.innerHTML).not.toContain(
      'data-runtime-setup-action="back"',
    );
    harness.click("back");
    expect(harness.container.innerHTML).toContain("Start chatting");
    harness.click("check");
    await vi.waitFor(() => expect(onCheckAgain).toHaveBeenCalledTimes(2));
    expect(harness.applySetup).toHaveBeenCalledOnce();
  });
  test("does not ignore a replacement chat key when returning to saved connection details", async () => {
    const harness = resumed({
      loadSetup: async () => ({
        setup: {
          ...savedSetup,
          existingModel: { provider: "openai", model: "chat-model" },
        },
      }),
    });
    await harness.open();
    harness.click("back");
    harness.inputKey("replacement-chat-secret");
    harness.submit();
    await harness.ready();
    expect(harness.submissions).toEqual([
      {
        provider: "openai",
        model: "chat-model",
        apiKey: "replacement-chat-secret",
        contextWindowTokens: 32768,
        deferActivation: true,
      },
    ]);
    expect(harness.fields["api-key"].value).toBe("");
    expect(harness.container.innerHTML).toContain("Add embedding");
    harness.click("back");
    harness.submit();
    await harness.ready();
    expect(harness.submissions).toHaveLength(1);
  });
  test("does not restore a plugin checkbox over an outside control after a pending save", async () => {
    const pending = deferred<any>();
    const harness = resumed({ setPlugin: () => pending.promise });
    const document = {
      activeElement: null as any,
      body: {},
      documentElement: {},
    };
    const outsideButton = { type: "button" };
    Object.assign(harness.container, {
      ownerDocument: document,
      contains: (element: unknown) => element !== outsideButton,
    });
    await openPlugins(harness);
    const input = pluginInput(harness, "read_file");
    document.activeElement = input;
    input.checked = false;
    input.dispatch("change");
    document.activeElement = outsideButton;
    pending.resolve(structuredClone(pluginSnapshot));
    await harness.ready();
    expect(pluginInput(harness, "read_file").focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outsideButton);
  });
});
