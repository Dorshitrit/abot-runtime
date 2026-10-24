import { afterEach, expect, test, vi } from "vitest";
import { createRuntimeSelectionController, type RuntimeSelectionControllerDependencies } from "../../web-ui/app/controllers/runtime-selection-controller.js";
import { createRuntimeOnboardingController } from "../../web-ui/app/controllers/runtime-onboarding-controller.js";
// @ts-expect-error Browser composition module has no declaration.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
// @ts-expect-error Browser composition module has no declaration.
import { createEnvironmentTransition } from "../../web-ui/app/controllers/environment-transition.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

function control(value = "") {
  const options: Array<{ value: string; textContent: string }> = [];
  return {
    value, options, hidden: false, disabled: false, title: "", textContent: "",
    get innerHTML() { return ""; },
    set innerHTML(_value: string) { options.length = 0; },
    classList: { toggle: vi.fn() }, setAttribute: vi.fn(), focus: vi.fn(),
    querySelectorAll: () => [], append: vi.fn(),
    appendChild: (option: { value: string; textContent: string }) => options.push(option),
  };
}

const catalog = {
  defaultProfileId: "model-a",
  profiles: [{ id: "model-a" }, { id: "model-b" }],
  availability: { status: "ready" },
};

function deferredCatalog() {
  let resolve!: (value: typeof catalog) => void;
  const promise = new Promise<typeof catalog>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  vi.stubGlobal("document", { createElement: () => control() });
  const state: RuntimeSelectionControllerDependencies["state"] & {
    runtimeAvailability: { status: string }; messages: unknown[];
  } = {
    config: { defaultEnvironmentId: "dev" }, currentSessionId: "dev-chat", messages: [],
    modelProfiles: [], defaultModelProfileId: "", pinnedSessionIds: [], sessionModes: {},
    sessionModels: { "dev-chat": "model-a", "prod-chat": "model-b" },
    lastModelByEnvironment: { dev: "model-a", prod: "model-b" },
    agentMode: "reasoning", supportedAgentModes: ["reasoning"],
    agentModeMenuOpen: false, permissionModeMenuOpen: false, agentPickerOpen: false,
    runtimeAvailability: { status: "ready" },
  };
  const dom = {
    environmentSelect: control("dev"), modelSelect: control(), sessionTitle: control(),
    agentPickerButton: control(), agentPickerMenu: control(),
    permissionModeButton: control(), permissionModeMenu: control(),
    agentModeButton: control(), agentModeMenu: control(),
  };
  let workspace = "home";
  const saved = vi.fn();
  const listModels = vi.fn(async (_environment: string) => catalog);
  const shell = createWorkspaceShell({
    ...createWorkspaceShellHarness(),
    // Same ordering as app.js: save outgoing selection, then switch composer scope.
    onWorkspaceChange(next: string) {
      selection.rememberModelSelection();
      workspace = next;
      selection.applyModelSelection();
    },
  });
  const onboarding = createRuntimeOnboardingController({
    state, getEnvironmentId: () => dom.environmentSelect.value,
    guide: { bind: vi.fn(), focusAction: vi.fn(), render: shell.runtimeAvailabilityChanged },
    reloadModels: async () => { await selection.loadModels(); }, setMessageStatus: vi.fn(),
  });
  const selection = createRuntimeSelectionController({
    state, dom,
    getComposerSessionId: () => workspace === "home" ? `home-${dom.environmentSelect.value}` : state.currentSessionId,
    preferences: {
      loadPinnedSessions: () => [], loadSessionModes: () => ({}), saveSessionModes: vi.fn(),
      loadLastToolPermissionMode: () => "ask", saveLastToolPermissionMode: vi.fn(),
      loadModelPreferences: () => ({ sessionModels: {}, lastModelByEnvironment: {} }),
      saveModelPreferences: saved,
    },
    modelSelector: { sync: vi.fn() }, recordControlEvent: vi.fn(),
    onAttachmentPolicyChange: vi.fn(),
    client: { listModels, getAgentMode: vi.fn(), setAgentMode: vi.fn() },
    onModelCatalogLoading: onboarding.beginCatalogLoad,
    onModelCatalogLoaded: onboarding.applyCatalog,
    onModelCatalogUnavailable: onboarding.catalogUnavailable,
  });
  shell.load();
  await selection.loadModels();
  await shell.activateWorkspace("chat", { focus: false });
  saved.mockClear();
  const transition = createEnvironmentTransition({
    state, dom, prepareQueueRecovery: () => true, onNavigationChange: vi.fn(),
    actions: {
      renderAgentPicker: vi.fn(), resetLiveRequestView: vi.fn(),
      applyConversationChrome: vi.fn(), renderMessages: vi.fn(), saveEnvironmentId: vi.fn(),
      loadModels: selection.loadModels, loadAgentMode: vi.fn(), loadRuntimeConfig: vi.fn(),
    },
  });
  return { state, dom, shell, selection, transition, saved, listModels };
}

afterEach(() => vi.unstubAllGlobals());

test("automatic Home navigation during an environment change preserves the destination's model preference", async () => {
  const f = await fixture();
  const pending = deferredCatalog();
  f.listModels.mockImplementationOnce(() => pending.promise);
  const originalSessions = { ...f.state.sessionModels };
  const originalEnvironments = { ...f.state.lastModelByEnvironment };
  const change = f.transition.changeEnvironment("prod", {
    restoreSession: false, notifyEnvironmentChange: false,
  });

  expect(f.dom.environmentSelect.value).toBe("prod");
  await vi.waitFor(() => expect(f.shell.activeWorkspace()).toBe("home"));
  expect(f.listModels).toHaveBeenLastCalledWith("prod");
  expect(f.state.sessionModels).toEqual(originalSessions);
  expect(f.state.lastModelByEnvironment).toEqual(originalEnvironments);
  expect(f.saved).not.toHaveBeenCalled();
  f.selection.rememberModelSelection();
  expect(f.saved).not.toHaveBeenCalled();

  pending.resolve(catalog);
  expect(await change).toBe(true);
  expect(f.dom.modelSelect.value).toBe("model-b");
  expect(f.state.lastModelByEnvironment.prod).toBe("model-b");
  f.dom.modelSelect.value = "model-a";
  f.selection.rememberModelSelection();
  expect(f.saved).toHaveBeenCalledOnce();
  expect(f.state.lastModelByEnvironment).toEqual({ dev: "model-a", prod: "model-a" });
  expect(f.state.sessionModels).toEqual({ ...originalSessions, "home-prod": "model-a" });
});

test("a same-environment catalog refresh still allows saving a model selection", async () => {
  const f = await fixture();
  const pending = deferredCatalog();
  f.listModels.mockImplementationOnce(() => pending.promise);
  const refresh = f.selection.loadModels();
  expect(f.shell.activeWorkspace()).toBe("chat");
  f.dom.modelSelect.value = "model-b";
  f.selection.rememberModelSelection();
  expect(f.saved).toHaveBeenCalledOnce();
  expect(f.state.sessionModels["dev-chat"]).toBe("model-b");
  expect(f.state.lastModelByEnvironment.dev).toBe("model-b");
  pending.resolve(catalog);
  await refresh;
  expect(f.dom.modelSelect.value).toBe("model-b");
});
