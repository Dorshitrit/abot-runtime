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
    await controller.upload({ name: "notes.txt", type: "text/plain" });

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
