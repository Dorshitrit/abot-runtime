import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildRuntimeSetupCommands,
  createRuntimeSetupGuide,
} from "../../web-ui/app/components/runtime-setup-guide.js";
import { createComposerAttachmentsController } from "../../web-ui/app/controllers/composer-attachments-controller.js";
import { createComposerSubmitController } from "../../web-ui/app/controllers/composer-submit-controller.js";
import { createRuntimeOnboardingController } from "../../web-ui/app/controllers/runtime-onboarding-controller.js";
import { createRuntimeSelectionController } from "../../web-ui/app/controllers/runtime-selection-controller.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

function createGuideHarness(copyText = vi.fn(async () => {})) {
  const listeners = new Map<
    string,
    (event: { target: Record<string, unknown> }) => void
  >();
  const action = { focus: vi.fn() };
  const modelInput = {
    focus: vi.fn(),
    reportValidity: vi.fn(),
    setAttribute: vi.fn(),
    setCustomValidity: vi.fn(),
  };
  const modelHelp = {
    textContent: "",
    classList: { toggle: vi.fn() },
  };
  const baseUrlInput = {
    focus: vi.fn(),
    reportValidity: vi.fn(),
    setAttribute: vi.fn(),
    setCustomValidity: vi.fn(),
  };
  const baseUrlHelp = {
    textContent: "",
    classList: { toggle: vi.fn() },
  };
  const commandIds = ["ollama-pull", "setup", "model-gateway", "web-ui"];
  const commandOutputs = Object.fromEntries(
    commandIds.map((id) => [id, { textContent: "" }]),
  ) as Record<string, { textContent: string }>;
  const copyButtons = Object.fromEntries(
    commandIds.map((id) => [id, { disabled: false }]),
  ) as Record<string, { disabled: boolean }>;
  const copyStatuses = Object.fromEntries(
    commandIds.map((id) => [
      id,
      { textContent: "", classList: { toggle: vi.fn() } },
    ]),
  ) as Record<
    string,
    { textContent: string; classList: { toggle: ReturnType<typeof vi.fn> } }
  >;
  const container = {
    hidden: true,
    innerHTML: "",
    addEventListener: vi.fn(
      (
        name: string,
        listener: (event: { target: Record<string, unknown> }) => void,
      ) => {
        listeners.set(name, listener);
      },
    ),
    querySelector: vi.fn((selector: string) => {
      if (selector === '[data-runtime-setup-action="check"]') return action;
      if (selector === "[data-runtime-setup-model]") return modelInput;
      if (selector === "[data-runtime-model-help]") return modelHelp;
      if (selector === "[data-runtime-setup-base-url]") return baseUrlInput;
      if (selector === "[data-runtime-base-url-help]") return baseUrlHelp;
      const commandOutput = selector.match(
        /^\[data-runtime-command-output="([^"]+)"\]$/,
      )?.[1];
      if (commandOutput) return commandOutputs[commandOutput] || null;
      const copyButton = selector.match(
        /^\[data-runtime-copy-button="([^"]+)"\]$/,
      )?.[1];
      if (copyButton) return copyButtons[copyButton] || null;
      const copyStatus = selector.match(
        /^\[data-runtime-copy-status="([^"]+)"\]$/,
      )?.[1];
      if (copyStatus) return copyStatuses[copyStatus] || null;
      if (selector.startsWith('[data-runtime-setup-field="provider"]')) {
        return { focus: vi.fn() };
      }
      return null;
    }),
    replaceChildren: vi.fn(() => {
      container.innerHTML = "";
    }),
  };
  const conversationRegion = { hidden: false };

  function dispatch(
    eventName: string,
    dataset: Record<string, string>,
    value = "",
  ) {
    const target = {
      dataset,
      value,
      setCustomValidity: vi.fn(),
      closest: (selector: string) => {
        if (
          selector === "[data-runtime-setup-action]" &&
          dataset.runtimeSetupAction
        ) {
          return target;
        }
        if (
          selector === "[data-runtime-setup-field]" &&
          dataset.runtimeSetupField
        ) {
          return target;
        }
        return null;
      },
    };
    listeners.get(eventName)?.({ target });
  }

  return {
    action,
    baseUrlHelp,
    baseUrlInput,
    changeProvider: (provider: string) =>
      dispatch("change", { runtimeSetupField: "provider" }, provider),
    click: (runtimeSetupAction: string, runtimeCommand = "") =>
      dispatch("click", { runtimeSetupAction, runtimeCommand }),
    commandOutputs,
    container,
    copyButtons,
    copyStatuses,
    copyText,
    conversationRegion,
    guide: createRuntimeSetupGuide({
      container: container as never,
      conversationRegion: conversationRegion as never,
      copyText,
    }),
    inputModel: (value: string) =>
      dispatch("input", { runtimeSetupField: "model-id" }, value),
    inputBaseUrl: (value: string) =>
      dispatch("input", { runtimeSetupField: "ollama-base-url" }, value),
    modelHelp,
    modelInput,
  };
}

function fakeElement(overrides: Record<string, unknown> = {}) {
  const options: Array<Record<string, unknown>> = [];
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    title: "",
    options,
    classList: { toggle: vi.fn() },
    setAttribute: vi.fn(),
    focus: vi.fn(),
    append: (...items: Array<Record<string, unknown>>) =>
      options.push(...items),
    appendChild: (item: Record<string, unknown>) => options.push(item),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("web ui runtime onboarding", () => {
  test("transports the setup-required model catalog as a successful semantic response", async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            defaultProfileId: "",
            profiles: [],
            availability: {
              status: "setup_required",
              code: "runtime_configuration_required",
              message: "Configure a provider and model.",
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: "/web-api" }),
      getEnvironmentId: () => "prod",
      fetchImpl,
      origin: "http://127.0.0.1:5177",
    });

    await expect(client.listModels()).resolves.toMatchObject({
      profiles: [],
      availability: {
        status: "setup_required",
        code: "runtime_configuration_required",
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/web-api/chat/models?environment=prod",
      { headers: {} },
    );
  });

  test("projects the actionable backend message when runtime config is corrupt", async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            error: "local_runtime_backend_error",
            message:
              "Invalid runtime config: models must be an object before setup can continue.",
          }),
          { status: 500 },
        ),
      ),
    );
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: "/web-api" }),
      getEnvironmentId: () => "prod",
      fetchImpl,
      origin: "http://127.0.0.1:5177",
    });

    await expect(client.listModels()).rejects.toThrow(
      "Invalid runtime config: models must be an object",
    );
  });

  test("shows provider-specific copyable setup commands without accepting a secret", async () => {
    const harness = createGuideHarness();
    const setMessageStatus = vi.fn();
    const state = { runtimeAvailability: { status: "loading" } };
    const controller = createRuntimeOnboardingController({
      state,
      guide: harness.guide,
      reloadModels: vi.fn(async () => {}),
      setMessageStatus,
    });
    controller.bind();

    controller.applyCatalog({
      defaultProfileId: "",
      profiles: [],
      availability: {
        status: "setup_required",
        code: "runtime_configuration_required",
        message: "Configure a provider and model before starting a chat.",
      },
    });

    expect(harness.container.hidden).toBe(false);
    expect(harness.conversationRegion.hidden).toBe(true);
    expect(harness.container.innerHTML).toContain("Connect your first model");
    expect(harness.container.innerHTML).toContain("Choose a provider");
    expect(harness.container.innerHTML).toContain("Ollama");
    expect(harness.container.innerHTML).toContain("OpenAI");
    expect(harness.container.innerHTML).toContain("required");
    expect(harness.container.innerHTML).toContain(
      "cannot run commands or restart services",
    );
    expect(harness.container.innerHTML).not.toContain("Open Config");
    expect(harness.copyButtons.setup.disabled).toBe(true);

    harness.inputModel("gemma3:4b");
    expect(harness.copyButtons.setup.disabled).toBe(true);
    harness.changeProvider("ollama");
    expect(harness.container.innerHTML).toContain("Enter the Ollama address");
    expect(harness.container.innerHTML).toContain(
      "http://host.docker.internal:11434",
    );
    expect(harness.container.innerHTML).toContain(
      "These may be the same environment or different ones.",
    );
    expect(harness.commandOutputs["ollama-pull"].textContent).toBe(
      "ollama pull gemma3:4b",
    );
    expect(harness.commandOutputs.setup.textContent).toBe(
      "npm run init -- --provider ollama --model gemma3:4b " +
        "--base-url http://127.0.0.1:11434",
    );
    expect(harness.copyButtons.setup.disabled).toBe(false);

    harness.inputBaseUrl("http://host.docker.internal:11434/");
    expect(harness.commandOutputs.setup.textContent).toBe(
      "npm run init -- --provider ollama --model gemma3:4b " +
        "--base-url http://host.docker.internal:11434",
    );

    harness.changeProvider("openai");
    expect(harness.container.innerHTML).toContain("OPENAI_API_KEY");
    expect(harness.container.innerHTML).toContain(
      "does not request, display, or store the secret",
    );
    expect(harness.container.innerHTML).not.toContain('type="password"');
    expect(harness.commandOutputs.setup.textContent).toBe(
      "npm run init -- --provider openai --model gemma3:4b",
    );
    harness.click("copy", "setup");
    await vi.waitFor(() =>
      expect(harness.copyText).toHaveBeenCalledWith(
        "npm run init -- --provider openai --model gemma3:4b",
      ),
    );
    expect(harness.copyStatuses.setup.textContent).toBe("Copied");

    controller.applyCatalog({
      defaultProfileId: "model-1",
      profiles: [{ id: "model-1" }],
      availability: { status: "ready" },
    });

    expect(controller.isReady()).toBe(true);
    expect(harness.container.hidden).toBe(true);
    expect(harness.conversationRegion.hidden).toBe(false);
    expect(harness.container.replaceChildren).toHaveBeenCalled();
    expect(setMessageStatus).toHaveBeenCalledWith(
      "Model ready. You can start chatting.",
    );
  });

  test.each([
    ["spaces", "gemma 3"],
    ["a single quote", "gemma'3"],
    ["a double quote", 'gemma"3'],
    ["an ampersand", "gemma&3"],
    ["a percent sign", "gemma%3"],
    ["a leading at sign", "@scope/model"],
    ["a leading comma", ",gemma3"],
    ["an embedded comma", "gemma,3"],
    ["a leading double dash", "--help"],
  ])("rejects model IDs containing %s", (_case, modelId) => {
    const harness = createGuideHarness();
    harness.guide.bind();
    harness.guide.render({ status: "setup_required", showGuide: true });
    harness.changeProvider("ollama");
    harness.inputModel(modelId);

    expect(harness.copyButtons.setup.disabled).toBe(true);
    expect(harness.copyButtons["ollama-pull"].disabled).toBe(true);
    expect(harness.commandOutputs["ollama-pull"].textContent).toBe(
      "ollama pull <model-id>",
    );
    expect(harness.commandOutputs.setup.textContent).toBe(
      "npm run init -- --provider ollama --model <model-id> " +
        "--base-url http://127.0.0.1:11434",
    );
    expect(harness.commandOutputs.setup.textContent).not.toContain("'\\''");
    expect(harness.modelHelp.textContent).not.toBe("");
    expect(harness.modelInput.setAttribute).toHaveBeenLastCalledWith(
      "aria-invalid",
      "true",
    );

    harness.click("copy", "setup");
    expect(harness.copyText).not.toHaveBeenCalled();
    expect(harness.modelInput.setCustomValidity).toHaveBeenLastCalledWith(
      expect.any(String),
    );
    expect(harness.copyStatuses.setup.textContent).not.toBe("");
  });

  test("rejects an Ollama address that is not a plain HTTP origin", () => {
    const harness = createGuideHarness();
    harness.guide.bind();
    harness.guide.render({ status: "setup_required", showGuide: true });
    harness.changeProvider("ollama");
    harness.inputModel("gemma3:4b");
    harness.inputBaseUrl("http://localhost:11434/api/tags");

    expect(harness.copyButtons.setup.disabled).toBe(true);
    expect(harness.commandOutputs.setup.textContent).toContain(
      "--base-url <ollama-base-url>",
    );
    expect(harness.baseUrlInput.setAttribute).toHaveBeenLastCalledWith(
      "aria-invalid",
      "true",
    );

    harness.click("copy", "setup");
    expect(harness.copyText).not.toHaveBeenCalled();
    expect(harness.baseUrlInput.reportValidity).toHaveBeenCalledOnce();
    expect(harness.copyStatuses.setup.textContent).toContain(
      "HTTP or HTTPS origin",
    );
  });

  test.each(["gemma3:4b", "gpt-5.6-luna"])(
    "accepts a real unquoted model ID: %s",
    (modelId) => {
      const commands = buildRuntimeSetupCommands("ollama", modelId);
      expect(commands.setup).toContain(`--model ${modelId}`);
      expect(commands.setup).not.toContain("<model-id>");
      expect(commands.setup).not.toContain("'");
    },
  );

  test("generates the single packaged CLI flow for npm consumers", () => {
    expect(
      buildRuntimeSetupCommands(
        "openai",
        "gpt-5.6-luna",
        "http://127.0.0.1:11434",
        "package",
      ),
    ).toMatchObject({
      setup: "npx abot init --provider openai --model gpt-5.6-luna",
      "model-gateway": "npx abot start",
      "web-ui": "",
    });
  });

  test.each([
    ["missing", undefined],
    ["unknown", { status: "warming" }],
  ])(
    "fails closed when catalog availability is %s despite profiles",
    (_case, availability) => {
      const state = { runtimeAvailability: { status: "loading" } };
      const controller = createRuntimeOnboardingController({
        state,
        guide: { bind: vi.fn(), focusAction: vi.fn(), render: vi.fn() },
        reloadModels: vi.fn(async () => {}),
        setMessageStatus: vi.fn(),
      });

      controller.applyCatalog({
        profiles: [{ id: "model-1" }],
        ...(availability ? { availability } : {}),
      });

      expect(state.runtimeAvailability).toMatchObject({
        status: "setup_required",
      });
      expect(controller.isReady()).toBe(false);
    },
  );

  test("checks the catalog exactly once and moves through checking to ready", async () => {
    const harness = createGuideHarness();
    const catalog = deferred<Record<string, unknown>>();
    let beginCatalogLoad = () => {};
    let applyCatalog = (_payload: Record<string, unknown>) => {};
    const reloadModels = vi.fn(async () => {
      beginCatalogLoad();
      applyCatalog(await catalog.promise);
    });
    const state = { runtimeAvailability: { status: "loading" } };
    const controller = createRuntimeOnboardingController({
      state,
      guide: harness.guide,
      reloadModels,
      setMessageStatus: vi.fn(),
    });
    beginCatalogLoad = controller.beginCatalogLoad;
    applyCatalog = controller.applyCatalog;
    controller.bind();
    controller.applyCatalog({
      profiles: [],
      availability: { status: "setup_required" },
    });

    harness.click("check");
    harness.click("check");
    await vi.waitFor(() => expect(reloadModels).toHaveBeenCalledOnce());
    expect(state.runtimeAvailability).toEqual({
      status: "checking",
      showGuide: true,
    });
    expect(harness.container.innerHTML).toContain("Checking the model catalog");
    expect(harness.container.innerHTML).toContain("Checking…");

    catalog.resolve({
      profiles: [{ id: "model-1" }],
      availability: { status: "ready" },
    });
    await vi.waitFor(() =>
      expect(state.runtimeAvailability).toEqual({ status: "ready" }),
    );
    expect(reloadModels).toHaveBeenCalledOnce();
    expect(harness.container.hidden).toBe(true);
  });

  test("shows a distinct error state when a catalog refresh fails", async () => {
    const harness = createGuideHarness();
    let beginCatalogLoad = () => {};
    let catalogUnavailable = (_error: Error) => {};
    const reloadModels = vi.fn(async () => {
      beginCatalogLoad();
      catalogUnavailable(new Error("model gateway is offline"));
    });
    const state = { runtimeAvailability: { status: "loading" } };
    const controller = createRuntimeOnboardingController({
      state,
      guide: harness.guide,
      reloadModels,
      setMessageStatus: vi.fn(),
    });
    beginCatalogLoad = controller.beginCatalogLoad;
    catalogUnavailable = controller.catalogUnavailable;
    controller.bind();
    controller.applyCatalog({
      profiles: [],
      availability: { status: "setup_required" },
    });

    harness.click("check");
    await vi.waitFor(() =>
      expect(state.runtimeAvailability).toMatchObject({ status: "error" }),
    );
    expect(reloadModels).toHaveBeenCalledOnce();
    expect(harness.container.hidden).toBe(false);
    expect(harness.container.innerHTML).toContain(
      "Could not check the model catalog",
    );
    expect(harness.container.innerHTML).toContain("model gateway is offline");
  });

  test("blocks send, steer, and send-next until the model catalog is ready", async () => {
    const harness = createGuideHarness();
    const setMessageStatus = vi.fn();
    const state = {
      runtimeAvailability: { status: "loading" },
      activeRequestId: "request-1",
      currentSessionId: "session-1",
      pendingAttachments: [] as unknown[],
      composerSending: false,
    };
    const onboarding = createRuntimeOnboardingController({
      state,
      guide: harness.guide,
      reloadModels: vi.fn(async () => {}),
      setMessageStatus,
    });
    onboarding.bind();
    onboarding.applyCatalog({
      defaultProfileId: "",
      profiles: [],
      availability: { status: "setup_required" },
    });

    const input = {
      value: "hello",
      scrollHeight: 72,
      style: { height: "" },
      focus: vi.fn(),
    };
    const composerActions = {
      primaryAction: vi.fn(() => "send"),
      render: vi.fn(),
    };
    const sendMessage = vi.fn(async () => {});
    const steer = vi.fn(async () => {});
    const enqueue = vi.fn(async () => {});
    const composer = createComposerSubmitController({
      state,
      dom: { composerInput: input },
      composerActions,
      attachments: { activeUploadCount: vi.fn(() => 0) },
      queue: {
        isCurrentDraining: vi.fn(() => false),
        queuedCount: vi.fn(() => 0),
        enqueue,
      },
      steer,
      chatRequests: { sendMessage },
      conversationSession: { appendRequestError: vi.fn() },
      selectedEnvironmentId: () => "prod",
      setMessageStatus,
      getSubmissionBlock: onboarding.submissionBlock,
      onSubmissionBlocked: onboarding.presentSubmissionBlock,
    });

    composer.updateSendState();
    expect(composerActions.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: true }),
    );
    composer.dispatch("send");
    input.value = "steer this";
    composer.dispatch("steer");
    input.value = "send this next";
    composer.dispatch("send_next");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(input.value).toBe("send this next");
    expect(setMessageStatus).toHaveBeenCalledWith(
      expect.stringContaining("provider and model"),
    );
    expect(harness.action.focus).toHaveBeenCalledTimes(3);

    onboarding.applyCatalog({
      defaultProfileId: "model-1",
      profiles: [{ id: "model-1" }],
      availability: { status: "ready" },
    });
    composer.updateSendState();
    expect(composerActions.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: false }),
    );
    state.activeRequestId = "";
    input.value = "hello";
    composer.dispatch();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  });

  test("disables attachments and rejects direct upload while setup is required", async () => {
    const attachmentButton = fakeElement();
    const uploadAttachment = vi.fn();
    const controller = createComposerAttachmentsController({
      state: {
        currentSessionId: "session-1",
        pendingAttachments: [],
        composerAttachmentGeneration: 0,
        pendingAttachmentUploadCounts: new Map(),
      },
      dom: {
        attachmentButton,
        attachmentPreview: fakeElement(),
      },
      shell: { showToast: vi.fn() },
      client: { uploadAttachment },
      selectedEnvironmentId: () => "prod",
      selectedModelSupportsImageInput: () => false,
      ensureSession: vi.fn(),
      onSendStateChange: vi.fn(),
      onControlEvent: vi.fn(),
      isComposerAvailable: () => false,
    });

    controller.render();
    expect(attachmentButton.disabled).toBe(true);
    expect(attachmentButton.title).toContain("provider and model");
    await expect(
      controller.upload({ name: "notes.txt", type: "text/plain" }),
    ).rejects.toThrow("provider and model");
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  test("enters checking synchronously before an environment model request settles", async () => {
    vi.stubGlobal("document", {
      createElement: () => fakeElement(),
    });
    const catalog = deferred<Record<string, unknown>>();
    const guide = {
      bind: vi.fn(),
      focusAction: vi.fn(),
      render: vi.fn(),
    };
    const state = {
      runtimeAvailability: { status: "ready" },
      config: {
        defaultEnvironmentId: "dev",
        environments: [{ id: "dev", label: "Development" }],
      },
      modelProfiles: [{ id: "old-model" }],
      defaultModelProfileId: "old-model",
      sessionModels: {},
      lastModelByEnvironment: {},
      currentSessionId: "",
    };
    const onboarding = createRuntimeOnboardingController({
      state,
      guide,
      reloadModels: vi.fn(async () => {}),
      setMessageStatus: vi.fn(),
    });
    const selection = createRuntimeSelectionController({
      state,
      dom: {
        environmentSelect: fakeElement({
          value: "dev",
          options: [{ value: "dev", textContent: "Development" }],
        }),
        modelSelect: fakeElement({
          value: "old-model",
          options: [{ value: "old-model", textContent: "Old Model" }],
        }),
      },
      preferences: {},
      modelSelector: { sync: vi.fn() },
      client: { listModels: vi.fn(() => catalog.promise) },
      recordControlEvent: vi.fn(),
      onAttachmentPolicyChange: vi.fn(),
      onModelCatalogLoading: onboarding.beginCatalogLoad,
      onModelCatalogLoaded: onboarding.applyCatalog,
      onModelCatalogUnavailable: onboarding.catalogUnavailable,
    });

    const loading = selection.loadModels();
    expect(state.runtimeAvailability).toEqual({
      status: "checking",
      showGuide: false,
    });
    expect(onboarding.submissionBlock()).toMatchObject({
      code: "runtime_setup_required",
    });

    catalog.resolve({
      defaultProfileId: "new-model",
      profiles: [{ id: "new-model", label: "New Model" }],
      availability: { status: "ready" },
    });
    await loading;
    expect(state.runtimeAvailability).toEqual({ status: "ready" });
  });
});
