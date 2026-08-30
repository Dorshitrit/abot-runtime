import { describe, expect, test, vi } from "vitest";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAppEventBindings } from "../../web-ui/app/controllers/app-event-bindings.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeEventElement() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  return {
    value: "",
    textContent: "",
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    contains: () => false,
    dispatch(type: string, event: Record<string, unknown> = {}) {
      for (const listener of listeners.get(type) || []) {
        listener({
          target: this,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          ...event,
        });
      }
    },
    focus: vi.fn(),
  };
}

function createDom() {
  const elements = new Map<PropertyKey, ReturnType<typeof fakeEventElement>>();
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (!elements.has(property)) elements.set(property, fakeEventElement());
        return elements.get(property);
      },
    },
  ) as Record<string, ReturnType<typeof fakeEventElement>>;
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const dom = createDom();
  dom.environmentSelect.value = "dev";
  const state = {
    activeComposerQueueRecovery: null,
    agentModeMenuOpen: false,
    agentPickerOpen: true,
    currentSessionId: "session-1",
    messages: [{ id: "message-1" }],
    permissionModeMenuOpen: false,
  };
  const actions = {
    applyConversationChrome: vi.fn(),
    beforeEnvironmentChange: vi.fn(() => true),
    clearAttachments: vi.fn(),
    invalidateSessionLoads: vi.fn(),
    loadAgentMode: vi.fn(async () => {}),
    loadModels: vi.fn(async () => {}),
    loadRuntimeConfig: vi.fn(async () => true),
    renderAgentPicker: vi.fn(),
    renderMessages: vi.fn(),
    resetLiveRequestView: vi.fn(),
    restoreLastSession: vi.fn(async () => {}),
    saveEnvironmentId: vi.fn(),
    savedEnvironmentId: vi.fn(() => "dev"),
    suspendQueueRecovery: vi.fn(() => true),
    ...overrides,
  };
  const shell = {
    closeOverlaysOnEscape: vi.fn(() => false),
    prepareWorkspaceActivation: vi.fn(() => vi.fn(() => true)),
    setSessionsDrawerOpen: vi.fn(),
  };
  const controller = createAppEventBindings({
    state,
    dom,
    shell,
    modelSelector: { close: vi.fn() },
    composerActions: {
      closeMenu: vi.fn(() => false),
      primaryAction: vi.fn(() => "send"),
    },
    actions,
    documentRoot: fakeEventElement(),
  });
  controller.bind();
  return { actions, dom, shell, state };
}

describe("web ui environment transitions", () => {
  test("restores the committed environment when config changes veto navigation", () => {
    const harness = createHarness({
      beforeEnvironmentChange: vi.fn(() => false),
    });

    harness.dom.environmentSelect.value = "prod";
    harness.dom.environmentSelect.dispatch("change");

    expect(harness.actions.beforeEnvironmentChange).toHaveBeenCalledWith({
      from: "dev",
      to: "prod",
    });
    expect(harness.dom.environmentSelect.value).toBe("dev");
    expect(harness.actions.suspendQueueRecovery).not.toHaveBeenCalled();
    expect(harness.actions.saveEnvironmentId).not.toHaveBeenCalled();
    expect(harness.actions.loadRuntimeConfig).not.toHaveBeenCalled();
    expect(harness.state.currentSessionId).toBe("session-1");
    expect(harness.state.messages).toEqual([{ id: "message-1" }]);
  });

  test("does not discard prepared config changes when queue recovery blocks navigation", () => {
    const discardPreparedChanges = vi.fn();
    const harness = createHarness({
      beforeEnvironmentChange: vi.fn(() => discardPreparedChanges),
      suspendQueueRecovery: vi.fn(() => false),
    });

    harness.dom.environmentSelect.value = "prod";
    harness.dom.environmentSelect.dispatch("change");

    expect(discardPreparedChanges).not.toHaveBeenCalled();
    expect(harness.dom.environmentSelect.value).toBe("dev");
    expect(harness.actions.saveEnvironmentId).not.toHaveBeenCalled();
    expect(harness.state.currentSessionId).toBe("session-1");
  });

  test("starts all environment-scoped loads without waiting for the model catalog", async () => {
    const pendingModels = deferred<void>();
    const harness = createHarness({
      loadModels: vi.fn(() => pendingModels.promise),
    });

    harness.dom.environmentSelect.value = "prod";
    harness.dom.environmentSelect.dispatch("change");

    expect(harness.actions.saveEnvironmentId).toHaveBeenCalledWith("prod");
    expect(harness.actions.invalidateSessionLoads).toHaveBeenCalledOnce();
    expect(harness.actions.loadModels).toHaveBeenCalledOnce();
    expect(harness.actions.loadAgentMode).toHaveBeenCalledOnce();
    expect(harness.actions.loadRuntimeConfig).toHaveBeenCalledWith({
      protectUnsaved: false,
      clearBeforeLoad: true,
    });
    expect(harness.actions.restoreLastSession).not.toHaveBeenCalled();

    pendingModels.resolve();
    await vi.waitFor(() =>
      expect(harness.actions.restoreLastSession).toHaveBeenCalledOnce(),
    );
  });
});

describe("web ui new-session transitions", () => {
  test("does not commit a prepared workspace change when queue recovery blocks navigation", () => {
    const harness = createHarness({
      suspendQueueRecovery: vi.fn(() => false),
    });
    const commitWorkspaceActivation = vi.fn(() => true);
    harness.shell.prepareWorkspaceActivation.mockReturnValue(
      commitWorkspaceActivation,
    );

    harness.dom.newSessionButton.dispatch("click");

    expect(harness.shell.prepareWorkspaceActivation).toHaveBeenCalledWith(
      "chat",
      { focus: false },
    );
    expect(harness.actions.suspendQueueRecovery).toHaveBeenCalledOnce();
    expect(commitWorkspaceActivation).not.toHaveBeenCalled();
    expect(harness.state.currentSessionId).toBe("session-1");
    expect(harness.state.messages).toEqual([{ id: "message-1" }]);
    expect(harness.actions.clearAttachments).not.toHaveBeenCalled();
    expect(harness.shell.setSessionsDrawerOpen).not.toHaveBeenCalled();
  });
});
