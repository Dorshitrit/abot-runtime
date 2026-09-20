import { afterEach, describe, expect, test, vi } from "vitest";

import { createGuideHarness } from "./support/runtime-setup-guide-harness.js";
import { createComposerAttachmentsController } from "../../web-ui/app/controllers/composer-attachments-controller.js";
import { createComposerSubmitController } from "../../web-ui/app/controllers/composer-submit-controller.js";
import { createRuntimeOnboardingController } from "../../web-ui/app/controllers/runtime-onboarding-controller.js";
import {
  createRuntimeSelectionController,
  type AgentMode,
} from "../../web-ui/app/controllers/runtime-selection-controller.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

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

    await harness.ready();
    harness.click("check");
    await harness.ready();
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

    await harness.ready();
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
        restoreText: vi.fn(),
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
      client: {
        attachmentPreviewUrl: vi.fn(() => ""),
        deleteAttachment: vi.fn(async () => {}),
        uploadAttachment,
      },
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
      controller.upload(
        Object.assign(new Blob(["notes"], { type: "text/plain" }), {
          name: "notes.txt",
        }),
      ),
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
      pinnedSessionIds: [] as string[],
      sessionModes: {},
      sessionModels: {},
      lastModelByEnvironment: {},
      agentMode: "reasoning" as AgentMode,
      supportedAgentModes: ["fast", "reasoning", "deep"] as AgentMode[],
      agentModeMenuOpen: false,
      permissionModeMenuOpen: false,
      agentPickerOpen: false,
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
        environmentSelect: {
          ...fakeElement(),
          value: "dev",
          options: [{ value: "dev", textContent: "Development" }],
        },
        modelSelect: {
          ...fakeElement(),
          value: "old-model",
          options: [{ value: "old-model", textContent: "Old Model" }],
        },
        agentPickerButton: fakeElement(),
        agentPickerMenu: fakeElement(),
        permissionModeButton: fakeElement(),
        permissionModeMenu: fakeElement(),
        agentModeButton: fakeElement(),
        agentModeMenu: fakeElement(),
      },
      preferences: {
        loadPinnedSessions: vi.fn(() => []),
        loadSessionModes: vi.fn(() => ({})),
        saveSessionModes: vi.fn(),
        loadLastToolPermissionMode: () => "full_access",
        saveLastToolPermissionMode: vi.fn(),
        loadModelPreferences: vi.fn(() => ({
          sessionModels: {},
          lastModelByEnvironment: {},
        })),
        saveModelPreferences: vi.fn(),
      },
      modelSelector: { sync: vi.fn() },
      client: {
        getAgentMode: vi.fn(async () => ({ mode: "reasoning" })),
        setAgentMode: vi.fn(async () => ({ mode: "reasoning" })),
        listModels: vi.fn(() => catalog.promise),
      },
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
