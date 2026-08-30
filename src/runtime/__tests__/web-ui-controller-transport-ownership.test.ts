import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createComposerAttachmentsController } from "../../web-ui/app/controllers/composer-attachments-controller.js";
import { createOperationsController } from "../../web-ui/app/controllers/operations-controller.js";
import { createRuntimeSelectionController } from "../../web-ui/app/controllers/runtime-selection-controller.js";

function fakeElement(overrides: Record<string, unknown> = {}) {
  const options: Array<Record<string, unknown>> = [];
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("web ui controller transport ownership", () => {
  test("tool approval controller receives presentation instead of importing components", () => {
    const source = readFileSync(
      new URL(
        "../../web-ui/app/controllers/tool-approval-controller.js",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'][^"']*components\//u);
  });

  test("operations controller consumes semantic runtime operations only", async () => {
    const dom = {
      runtimeStatus: fakeElement(),
      runtimeLogs: fakeElement(),
      healthStatus: fakeElement(),
    };
    const client = {
      getRuntimeStatus: vi.fn(async () => ({
        source: "runtime",
        status: { pid: 42, uptimeMs: 2000, node: { version: "v24" } },
      })),
      getRuntimeLogs: vi.fn(async () => ({ log: { lines: ["ready"] } })),
      getSystemHealth: vi.fn(async () => ({
        ok: true,
        activeStreamingRequestDetails: [],
      })),
    };
    const controller = createOperationsController({
      dom: dom as never,
      client,
    });

    await controller.loadRuntimeStatus();
    await controller.loadRuntimeLogs();
    await controller.loadSystemHealth();

    expect(client.getRuntimeStatus).toHaveBeenCalledOnce();
    expect(client.getRuntimeLogs).toHaveBeenCalledWith(100);
    expect(client.getSystemHealth).toHaveBeenCalledOnce();
    expect(dom.runtimeLogs.textContent).toBe("ready");
  });

  test("selection controller delegates model and mode transport to semantic operations", async () => {
    vi.stubGlobal("document", {
      createElement: () => fakeElement(),
    });
    const dom = {
      environmentSelect: fakeElement({
        value: "dev",
        options: [{ value: "dev", textContent: "Development" }],
      }),
      modelSelect: fakeElement(),
      agentModeButton: fakeElement(),
      agentModeMenu: fakeElement(),
      agentPickerButton: fakeElement(),
      agentPickerMenu: fakeElement(),
      permissionModeButton: fakeElement(),
      permissionModeMenu: fakeElement(),
    };
    const state = {
      config: {
        defaultEnvironmentId: "dev",
        environments: [{ id: "dev", label: "Development" }],
      },
      agentMode: "reasoning",
      supportedAgentModes: ["reasoning", "deep"],
      agentModeMenuOpen: false,
      agentPickerOpen: false,
      permissionModeMenuOpen: false,
      modelProfiles: [],
      defaultModelProfileId: "",
      sessionModes: {},
      sessionModels: {},
      lastModelByEnvironment: {},
      pinnedSessionIds: new Set<string>(),
      currentSessionId: "session-1",
    };
    const client = {
      getAgentMode: vi.fn(async () => ({
        mode: "reasoning",
        supportedModes: ["reasoning", "deep"],
      })),
      setAgentMode: vi.fn(async () => ({ mode: "deep" })),
      listModels: vi.fn(async () => ({
        defaultProfileId: "model-1",
        profiles: [{ id: "model-1", label: "Model 1" }],
      })),
    };
    const controller = createRuntimeSelectionController({
      state: state as never,
      dom: dom as never,
      preferences: {} as never,
      modelSelector: { sync: vi.fn() },
      client,
      recordControlEvent: vi.fn(),
      onAttachmentPolicyChange: vi.fn(),
    });

    await controller.loadAgentMode();
    await controller.setAgentMode("deep");
    await controller.loadModels();

    expect(client.getAgentMode).toHaveBeenCalledWith("dev");
    expect(client.setAgentMode).toHaveBeenCalledWith("deep", "dev");
    expect(client.listModels).toHaveBeenCalledWith("dev");
    expect(state.modelProfiles).toEqual([{ id: "model-1", label: "Model 1" }]);
  });

  test("selection controller ignores model and mode responses from a previous environment", async () => {
    vi.stubGlobal("document", {
      createElement: () => fakeElement(),
    });
    const staleDevMode = deferred<Record<string, unknown>>();
    const prodMode = deferred<Record<string, unknown>>();
    const currentDevMode = deferred<Record<string, unknown>>();
    const staleModeMutation = deferred<Record<string, unknown>>();
    const staleDevModels = deferred<Record<string, unknown>>();
    const prodModels = deferred<Record<string, unknown>>();
    const currentDevModels = deferred<Record<string, unknown>>();
    const environmentSelect = fakeElement({ value: "dev" });
    const state = {
      config: {
        defaultEnvironmentId: "dev",
        environments: [
          { id: "dev", label: "Development" },
          { id: "prod", label: "Production" },
        ],
      },
      agentMode: "reasoning",
      supportedAgentModes: ["reasoning", "deep"],
      agentModeMenuOpen: false,
      agentPickerOpen: false,
      permissionModeMenuOpen: false,
      modelProfiles: [],
      defaultModelProfileId: "",
      sessionModes: {},
      sessionModels: {},
      lastModelByEnvironment: {},
      pinnedSessionIds: new Set<string>(),
      currentSessionId: "session-1",
    };
    const client = {
      getAgentMode: vi
        .fn()
        .mockReturnValueOnce(staleDevMode.promise)
        .mockReturnValueOnce(prodMode.promise)
        .mockReturnValueOnce(currentDevMode.promise),
      listModels: vi
        .fn()
        .mockReturnValueOnce(staleDevModels.promise)
        .mockReturnValueOnce(prodModels.promise)
        .mockReturnValueOnce(currentDevModels.promise),
      setAgentMode: vi.fn(() => staleModeMutation.promise),
    };
    const controller = createRuntimeSelectionController({
      state: state as never,
      dom: {
        environmentSelect,
        modelSelect: fakeElement(),
        agentModeButton: fakeElement(),
        agentModeMenu: fakeElement(),
        agentPickerButton: fakeElement(),
        agentPickerMenu: fakeElement(),
        permissionModeButton: fakeElement(),
        permissionModeMenu: fakeElement(),
      } as never,
      preferences: {} as never,
      modelSelector: { sync: vi.fn() },
      client,
      recordControlEvent: vi.fn(),
      onAttachmentPolicyChange: vi.fn(),
      onModelCatalogLoading: vi.fn(),
      onModelCatalogLoaded: vi.fn(),
      onModelCatalogUnavailable: vi.fn(),
    });

    const staleSet = controller.setAgentMode("deep");
    const staleModeLoad = controller.loadAgentMode();
    const staleModelLoad = controller.loadModels();
    environmentSelect.value = "prod";
    const staleProdModeLoad = controller.loadAgentMode();
    const staleProdModelLoad = controller.loadModels();
    environmentSelect.value = "dev";
    const currentModeLoad = controller.loadAgentMode();
    const currentModelLoad = controller.loadModels();
    currentDevMode.resolve({
      mode: "deep",
      supportedModes: ["reasoning", "deep"],
    });
    currentDevModels.resolve({
      defaultProfileId: "current-dev-model",
      profiles: [{ id: "current-dev-model", label: "Current dev model" }],
    });

    await expect(currentModeLoad).resolves.toBe(true);
    await expect(currentModelLoad).resolves.toBe(true);
    staleDevMode.resolve({ mode: "reasoning", supportedModes: ["reasoning"] });
    staleDevModels.resolve({
      defaultProfileId: "stale-dev-model",
      profiles: [{ id: "stale-dev-model", label: "Stale dev model" }],
    });
    prodMode.resolve({ mode: "reasoning", supportedModes: ["reasoning"] });
    prodModels.resolve({
      defaultProfileId: "prod-model",
      profiles: [{ id: "prod-model", label: "Production model" }],
    });
    await expect(staleModeLoad).resolves.toBe(false);
    await expect(staleModelLoad).resolves.toBe(false);
    await expect(staleProdModeLoad).resolves.toBe(false);
    await expect(staleProdModelLoad).resolves.toBe(false);
    staleModeMutation.resolve({ mode: "fast" });
    await expect(staleSet).resolves.toBe(true);

    expect(state.agentMode).toBe("fast");
    expect(state.defaultModelProfileId).toBe("current-dev-model");
    expect(state.modelProfiles).toEqual([
      { id: "current-dev-model", label: "Current dev model" },
    ]);
  });

  test("keeps a successful mode mutation authoritative over an older read", async () => {
    vi.stubGlobal("document", {
      createElement: () => fakeElement(),
    });
    const modeMutation = deferred<Record<string, unknown>>();
    const modeLoad = deferred<Record<string, unknown>>();
    const environmentSelect = fakeElement({ value: "dev" });
    const state = {
      config: {
        defaultEnvironmentId: "dev",
        environments: [{ id: "dev", label: "Development" }],
      },
      agentMode: "reasoning",
      supportedAgentModes: ["reasoning", "deep"],
      agentModeMenuOpen: false,
      agentPickerOpen: false,
      permissionModeMenuOpen: false,
      modelProfiles: [],
      defaultModelProfileId: "",
      sessionModes: {},
      sessionModels: {},
      lastModelByEnvironment: {},
      pinnedSessionIds: new Set<string>(),
      currentSessionId: "session-1",
    };
    const controller = createRuntimeSelectionController({
      state: state as never,
      dom: {
        environmentSelect,
        modelSelect: fakeElement(),
        agentModeButton: fakeElement(),
        agentModeMenu: fakeElement(),
        agentPickerButton: fakeElement(),
        agentPickerMenu: fakeElement(),
        permissionModeButton: fakeElement(),
        permissionModeMenu: fakeElement(),
      } as never,
      preferences: {} as never,
      modelSelector: { sync: vi.fn() },
      client: {
        getAgentMode: vi.fn(() => modeLoad.promise),
        setAgentMode: vi.fn(() => modeMutation.promise),
        listModels: vi.fn(),
      },
      recordControlEvent: vi.fn(),
      onAttachmentPolicyChange: vi.fn(),
    });

    const mutation = controller.setAgentMode("deep");
    const load = controller.loadAgentMode();
    modeMutation.resolve({ mode: "deep" });

    await expect(mutation).resolves.toBe(true);
    expect(state.agentMode).toBe("deep");

    modeLoad.resolve({
      mode: "reasoning",
      supportedModes: ["reasoning", "deep"],
    });
    await expect(load).resolves.toBe(false);
    expect(state.agentMode).toBe("deep");
  });

  test("does not issue overlapping mode writes", async () => {
    vi.stubGlobal("document", {
      createElement: () => fakeElement(),
    });
    const modeMutation = deferred<Record<string, unknown>>();
    const agentModeButton = fakeElement();
    const state = {
      config: {
        defaultEnvironmentId: "dev",
        environments: [{ id: "dev", label: "Development" }],
      },
      agentMode: "reasoning",
      supportedAgentModes: ["reasoning", "deep"],
      agentModeMenuOpen: false,
      agentPickerOpen: false,
      permissionModeMenuOpen: false,
      modelProfiles: [],
      defaultModelProfileId: "",
      sessionModes: {},
      sessionModels: {},
      lastModelByEnvironment: {},
      pinnedSessionIds: new Set<string>(),
      currentSessionId: "session-1",
    };
    const setAgentMode = vi.fn(() => modeMutation.promise);
    const controller = createRuntimeSelectionController({
      state: state as never,
      dom: {
        environmentSelect: fakeElement({ value: "dev" }),
        modelSelect: fakeElement(),
        agentModeButton,
        agentModeMenu: fakeElement(),
        agentPickerButton: fakeElement(),
        agentPickerMenu: fakeElement(),
        permissionModeButton: fakeElement(),
        permissionModeMenu: fakeElement(),
      } as never,
      preferences: {} as never,
      modelSelector: { sync: vi.fn() },
      client: {
        getAgentMode: vi.fn(),
        setAgentMode,
        listModels: vi.fn(),
      },
      recordControlEvent: vi.fn(),
      onAttachmentPolicyChange: vi.fn(),
    });

    const firstMutation = controller.setAgentMode("deep");
    expect(agentModeButton.disabled).toBe(true);
    await expect(controller.setAgentMode("reasoning")).resolves.toBe(false);
    expect(setAgentMode).toHaveBeenCalledOnce();

    modeMutation.resolve({ mode: "deep" });
    await expect(firstMutation).resolves.toBe(true);
    expect(agentModeButton.disabled).toBe(false);
    expect(state.agentMode).toBe("deep");
  });

  test("attachment controller delegates preview, cleanup, and upload transport", async () => {
    vi.stubGlobal("document", {
      createElement: () => fakeElement(),
    });
    const state = {
      currentSessionId: "session-1",
      pendingAttachments: [] as Array<Record<string, unknown>>,
      composerAttachmentGeneration: 0,
      pendingAttachmentUploadCounts: new Map<number, number>(),
    };
    const client = {
      attachmentPreviewUrl: vi.fn(() => "/preview/attachment-1"),
      deleteAttachment: vi.fn(async () => undefined),
      uploadAttachment: vi.fn(async () => ({
        id: "attachment-1",
        storageRef: "session-1/attachment-1",
        mimeType: "text/plain",
        name: "notes.txt",
      })),
    };
    const controller = createComposerAttachmentsController({
      state: state as never,
      dom: {
        attachmentButton: fakeElement(),
        attachmentPreview: fakeElement(),
      } as never,
      shell: { showToast: vi.fn() },
      client,
      selectedEnvironmentId: () => "dev",
      selectedModelSupportsImageInput: () => true,
      ensureSession: vi.fn(),
      onSendStateChange: vi.fn(),
      onControlEvent: vi.fn(),
    });
    const attachment = {
      id: "attachment-1",
      storageRef: "session-1/attachment-1",
      mimeType: "text/plain",
      sessionId: "session-1",
      environment: "dev",
    };

    expect(controller.previewUrl(attachment)).toBe("/preview/attachment-1");
    await controller.deletePending(attachment);
    await controller.upload(
      Object.assign(new Blob(["notes"], { type: "text/plain" }), {
        name: "notes.txt",
      }),
    );

    expect(client.attachmentPreviewUrl).toHaveBeenCalledWith({
      environmentId: "dev",
      sessionId: "session-1",
      storageRef: "session-1/attachment-1",
      id: "attachment-1",
      mimeType: "text/plain",
    });
    expect(client.deleteAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "attachment-1" }),
    );
    expect(client.uploadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "dev",
        sessionId: "session-1",
        name: "notes.txt",
        mimeType: "text/plain",
      }),
    );
    expect(state.pendingAttachments).toHaveLength(1);
  });
});
