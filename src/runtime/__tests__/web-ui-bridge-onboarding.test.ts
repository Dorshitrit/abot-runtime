import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntimeOnboardingFeature } from "../../web-ui/app/runtime-onboarding-feature.js";
import { createGuideHarness } from "./support/runtime-setup-guide-harness.js";

function createFeature(
  backend: string | null = "bridge",
  commandMode = "source",
) {
  const harness = createGuideHarness();
  const state = {
    config: backend
      ? ({ backend, setupCommandMode: commandMode } as Record<string, unknown>)
      : null,
    runtimeAvailability: { status: "loading" },
  };
  const runtimeClient = {
    getRuntimeSetup: harness.loadSetup,
    saveRuntimeSetup: harness.saveSetup,
    applyRuntimeConfiguration: harness.applySetup,
    loadLongTermMemoryStatus: harness.loadEmbeddingStatus,
    loadModelSetup: vi.fn(async () => ({ providers: [] })),
    discoverLongTermMemoryModels: harness.discoverEmbeddingModels,
    saveRuntimeSetupEmbedding: harness.saveEmbedding,
    getRuntimePlugins: harness.loadPlugins,
    setRuntimePlugin: harness.setPlugin,
  };
  const reloadModels = vi.fn(async () => {});
  const reloadCatalog = vi.fn(async () => {});
  const feature = createRuntimeOnboardingFeature({
    dom: {
      runtimeSetupGuide: harness.container as never,
      messagesList: harness.conversationRegion as never,
    },
    state,
    runtimeClient,
    selectedEnvironmentId: () => "prod",
    reloadModels,
    reloadCatalog,
    setMessageStatus: vi.fn(),
  });
  const copyText = vi.fn(async (_value: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText: copyText } });
  feature.controller.bind();
  function open() {
    feature.controller.applyCatalog({
      profiles: [],
      availability: { status: "setup_required" },
    });
  }
  function copy(commandId = "setup") {
    const click = harness.container.addEventListener.mock.calls.find(
      ([name]) => name === "click",
    )?.[1];
    const target = {
      dataset: { runtimeSetupAction: "copy", runtimeCommand: commandId },
      closest: () => target,
    };
    click?.({ target });
  }
  return {
    ...harness,
    ...feature,
    state,
    runtimeClient,
    reloadModels,
    reloadCatalog,
    copyText,
    open,
    copy,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Bridge onboarding backend selection", () => {
  test("waits for backend metadata and never calls local setup APIs in Bridge states", () => {
    const harness = createFeature(null);
    harness.open();
    expect(harness.container.hidden).toBe(true);
    expect(harness.runtimeClient.getRuntimeSetup).not.toHaveBeenCalled();
    harness.state.config = { backend: "bridge", setupCommandMode: "source" };
    harness.controller.render();
    expect(harness.container.innerHTML).toContain(
      "Connect the external runtime",
    );
    harness.controller.catalogUnavailable(
      new Error("Bridge catalog is offline"),
    );
    expect(harness.container.innerHTML).toContain("Bridge catalog is offline");
    harness.controller.beginCatalogLoad();
    expect(harness.container.innerHTML).toContain("Checking the model catalog");
    for (const request of Object.values(harness.runtimeClient))
      expect(request).not.toHaveBeenCalled();
  });

  test("keeps the local provider/connection workflow and its applied-environment refresh", async () => {
    const harness = createFeature("runtime");
    harness.open();
    await harness.ready();
    expect(harness.loadSetup).toHaveBeenCalledOnce();
    expect(harness.container.innerHTML).toContain("Connect your first model");
    harness.changeProvider("openai");
    harness.submit();
    expect(harness.container.innerHTML).toContain(
      'data-runtime-setup-field="api-key"',
    );
    harness.click("check");
    await vi.waitFor(() => expect(harness.reloadModels).toHaveBeenCalledOnce());
    expect(harness.reloadCatalog).not.toHaveBeenCalled();
  });

  test("Check again performs one catalog-only refresh and closes recovery once ready", async () => {
    const harness = createFeature();
    harness.open();
    let resolveCatalog!: () => void;
    harness.reloadCatalog.mockImplementationOnce(async () => {
      harness.controller.beginCatalogLoad();
      await new Promise<void>((resolve) => {
        resolveCatalog = resolve;
      });
      harness.controller.applyCatalog({
        profiles: [{ id: "ready-model" }],
        availability: { status: "ready" },
      });
    });
    harness.click("check");
    harness.click("check");
    await vi.waitFor(() =>
      expect(harness.reloadCatalog).toHaveBeenCalledOnce(),
    );
    expect(harness.container.innerHTML).toContain("Checking…");
    harness.click("check");
    resolveCatalog();
    await vi.waitFor(() => expect(harness.controller.isReady()).toBe(true));
    expect(harness.container.hidden).toBe(true);
    expect(harness.conversationRegion.hidden).toBe(false);
    expect(harness.reloadModels).not.toHaveBeenCalled();
    for (const request of Object.values(harness.runtimeClient))
      expect(request).not.toHaveBeenCalled();
  });

  test.each([
    [
      "source",
      "npm run init -- --provider ollama --model llama-test --base-url http://localhost:11434",
      "npm run model-gateway",
    ],
    [
      "package",
      "npx abot init --provider ollama --model llama-test --base-url http://localhost:11434",
      "",
    ],
  ])(
    "provides validated, copyable %s recovery commands",
    async (mode, init, start) => {
      const harness = createFeature("bridge", mode);
      harness.open();
      harness.changeProvider("ollama");
      harness.inputModel("llama-test");
      harness.inputBaseUrl("http://localhost:11434");
      harness.submit();
      expect(harness.container.innerHTML).toContain(
        "Finish setup on the runtime host",
      );
      expect(harness.container.innerHTML).toContain(init);
      expect(harness.container.innerHTML).not.toContain(
        'data-runtime-command="web-ui"',
      );
      expect(harness.container.innerHTML).not.toContain("npm run web-ui");
      expect(harness.container.innerHTML).not.toContain("npx abot start");
      if (start) expect(harness.container.innerHTML).toContain(start);
      expect(
        harness.container.innerHTML.includes(
          'data-runtime-command="model-gateway"',
        ),
      ).toBe(mode === "source");
      harness.copy();
      await vi.waitFor(() =>
        expect(harness.copyText).toHaveBeenCalledWith(init),
      );
      harness.copy("ollama-pull");
      await vi.waitFor(() =>
        expect(harness.copyText).toHaveBeenCalledWith("ollama pull llama-test"),
      );
      const copiedCommands = harness.copyText.mock.calls.length;
      harness.copy("web-ui");
      if (mode === "package") harness.copy("model-gateway");
      expect(harness.copyText).toHaveBeenCalledTimes(copiedCommands);
      if (mode === "source") {
        harness.copy("model-gateway");
        await vi.waitFor(() =>
          expect(harness.copyText).toHaveBeenCalledWith(start),
        );
      }
      harness.click("back");
      expect(harness.container.innerHTML).toContain('value="llama-test"');
      expect(harness.container.innerHTML).toContain(
        'value="http://localhost:11434"',
      );
      expect(harness.title.focus).toHaveBeenCalled();
    },
  );

  test("keeps OpenAI credentials out of forms, commands, and browser storage", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    const harness = createFeature("bridge", "package");
    harness.open();
    harness.changeProvider("openai");
    harness.inputModel("openai-test");
    harness.submit();
    expect(harness.container.innerHTML).toContain("OPENAI_API_KEY");
    expect(harness.container.innerHTML).not.toContain('type="password"');
    expect(harness.container.innerHTML).not.toContain(
      'data-runtime-setup-field="api-key"',
    );
    harness.copy();
    await vi.waitFor(() =>
      expect(harness.copyText).toHaveBeenCalledWith(
        "npx abot init --provider openai --model openai-test",
      ),
    );
    expect(setItem).not.toHaveBeenCalled();
    for (const request of Object.values(harness.runtimeClient))
      expect(request).not.toHaveBeenCalled();
  });

  test.each([
    ["model", "model;echo unsafe", "http://localhost:11434"],
    ["address", "safe-model", "https://user:private@example.com"],
  ])(
    "rejects unsafe %s input before exposing or copying commands",
    (field, model, address) => {
      const harness = createFeature();
      harness.open();
      harness.changeProvider("ollama");
      harness.inputModel(model);
      harness.inputBaseUrl(address);
      harness.submit();
      expect(harness.container.innerHTML).not.toContain(
        "Finish setup on the runtime host",
      );
      expect(harness.container.innerHTML).toContain('role="alert"');
      harness.copy();
      expect(harness.copyText).not.toHaveBeenCalled();
      expect(
        harness.fields[field === "model" ? "model-id" : "ollama-base-url"]
          .focus,
      ).toHaveBeenCalled();
    },
  );

  test("retains recovery choices on catalog errors and reconstructs after page disposal", async () => {
    const harness = createFeature();
    harness.open();
    harness.changeProvider("ollama");
    harness.inputModel("saved-choice");
    harness.submit();
    harness.controller.catalogUnavailable(new Error("<broken-bridge>"));
    expect(harness.container.innerHTML).toContain("saved-choice");
    expect(harness.container.innerHTML).toContain("&lt;broken-bridge&gt;");
    expect(harness.container.innerHTML).not.toContain("<broken-bridge>");
    harness.guide.dispose();
    expect(harness.container.innerHTML).toBe("");
    harness.controller.render();
    expect(harness.container.innerHTML).toContain(
      "Connect the external runtime",
    );
    expect(harness.container.innerHTML).not.toContain("saved-choice");
    expect(harness.runtimeClient.getRuntimeSetup).not.toHaveBeenCalled();
  });
});
