import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAppEventBindings } from "../../web-ui/app/controllers/app-event-bindings.js";

function element() {
  const listeners = new Map<string, Array<(event: unknown) => unknown>>();
  return {
    value: "", textContent: "", focus: vi.fn(), contains: () => false,
    addEventListener(type: string, listener: (event: unknown) => unknown) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    dispatch(type: string) {
      return Promise.all((listeners.get(type) || []).map((listener) => listener({
        target: this, preventDefault: vi.fn(), stopPropagation: vi.fn(),
      })));
    },
  };
}

function createNewSessionHarness() {
  const elements = new Map<PropertyKey, ReturnType<typeof element>>();
  const dom = new Proxy({}, { get(_target, key) {
    if (!elements.has(key)) elements.set(key, element());
    return elements.get(key);
  } }) as Record<string, ReturnType<typeof element>>;
  dom.environmentSelect.value = "dev";
  dom.modelSelect.value = "observed-smoke-model";
  const state = { currentSessionId: "smoke", messages: [{ id: "existing" }], agentModeMenuOpen: false, agentPickerOpen: false };
  let initializedModel = "";
  const actions = {
    selectedEnvironmentId: () => "dev", suspendQueueRecovery: () => true,
    resetLiveRequestView: vi.fn(), applyModelSelection: vi.fn(() => { dom.modelSelect.value = "preferred-model"; }),
    rememberModelSelection: vi.fn(), saveSessionId: vi.fn(), setCurrentSessionTitle: vi.fn(),
    applyConversationChrome: vi.fn(), subscribeSession: vi.fn(), renderSessions: vi.fn(), renderMessages: vi.fn(),
    removeUnsupportedImages: vi.fn(), renderAttachments: vi.fn(),
  };
  const controller = createAppEventBindings({ state, dom, actions,
    onSessionCreated: () => { initializedModel = dom.modelSelect.value; },
    shell: { prepareWorkspaceActivation: () => () => true, setSessionsDrawerOpen: vi.fn() },
    modelSelector: { close: vi.fn() }, composerActions: {}, documentRoot: element(),
  });
  controller.bind();
  return { state, dom, actions, controller, initializedModel: () => initializedModel };
}

describe("new conversation model preference wiring", () => {
  test("new conversation initializes with the preferred model after viewing an external run", async () => {
    const h = createNewSessionHarness();

    await h.dom.newSessionButton.dispatch("click");

    expect(h.state.currentSessionId).not.toBe("smoke");
    expect(h.initializedModel()).toBe("preferred-model");
    expect(h.dom.modelSelect.value).toBe("preferred-model");
    expect(h.state.messages).toEqual([]);
    expect(h.actions.rememberModelSelection).toHaveBeenCalledExactlyOnceWith();
  });

  test("only a direct model selection marks the preference as an explicit user choice", async () => {
    const h = createNewSessionHarness();
    await h.dom.newSessionButton.dispatch("click");
    h.actions.rememberModelSelection.mockClear();

    h.dom.modelSelect.value = "manually-selected-model";
    await h.dom.modelSelect.dispatch("change");

    expect(h.actions.rememberModelSelection).toHaveBeenCalledExactlyOnceWith({ explicit: true });
    expect(h.actions.removeUnsupportedImages).toHaveBeenCalledOnce();
  });
});
