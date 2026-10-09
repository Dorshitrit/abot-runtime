import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntimeOnboardingFeature } from "../../web-ui/app/runtime-onboarding-feature.js";
import type { RuntimeAvailability } from "../../web-ui/app/controllers/runtime-onboarding-controller.js";
// @ts-expect-error Browser composition module.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
// @ts-expect-error Browser composition module.
import { createComputerAccessFeature } from "../../web-ui/app/computer-access-feature.js";
// @ts-expect-error Browser composition module.
import { createAppEventBindings } from "../../web-ui/app/controllers/app-event-bindings.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

const capture = vi.hoisted(() => ({ manager: null as any, guide: null as any }));
vi.mock("../../web-ui/app/components/system-host/manager.js", () => ({
  createSystemHostConnectionManager: () => capture.manager,
}));
vi.mock("../../web-ui/app/components/system-host/setup-notice.js", () => ({
  createSystemHostSetupNotice: () => ({ render: vi.fn(), dispose: vi.fn() }),
}));
vi.mock("../../web-ui/app/components/runtime-setup-guide.js", () => ({
  createRuntimeSetupGuide: () => capture.guide,
}));
vi.mock("../../web-ui/app/components/runtime-setup/bridge-guide.js", () => ({
  createBridgeSetupGuide: () => capture.guide,
}));

type Catalog = { profiles: Array<{ id: string }>; availability: RuntimeAvailability };
const readyCatalog: Catalog = { profiles: [{ id: "configured-model" }], availability: { status: "ready" } };
const recoveryCatalog: Catalog = { profiles: [], availability: { status: "setup_required", recovery: "configuration" } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function fixture() {
  const workspace = createWorkspaceShellHarness();
  const shell = createWorkspaceShell(workspace);
  const environmentSelect = Object.assign(new EventTarget(), { value: "env-a" });
  const card = { hidden: false, setAttribute: vi.fn(), focus: vi.fn(), remove: vi.fn() };
  const documentRoot = { createElement: vi.fn(() => card) };
  const dom = {
    ...workspace.dom, environmentSelect, sessionTitle: { textContent: "" },
    runtimeSetupGuide: { hidden: true }, messagesList: { hidden: false },
    homeDashboardRoot: { ownerDocument: documentRoot, parentElement: { insertBefore: vi.fn() } },
  };
  const state = {
    config: null as Record<string, unknown> | null,
    runtimeAvailability: { status: "loading" } as RuntimeAvailability,
    currentSessionId: "", messages: [], agentPickerOpen: false,
  };
  const mountedVisibility: boolean[] = [];
  const environmentObservations: Array<Record<string, unknown>> = [];
  const manager = {
    state: { active: true },
    mount: vi.fn((root: typeof card) => { mountedVisibility.push(root.hidden); }),
    setActive: vi.fn((active: boolean) => { manager.state.active = active; }),
    load: vi.fn(async () => true),
    environmentChanged: vi.fn(() => { environmentObservations.push(observeAccess()); }),
    openManagement: vi.fn(), dispose: vi.fn(),
  };
  function observeAccess() {
    return {
      environment: environmentSelect.value,
      status: state.runtimeAvailability.status,
      recovery: state.runtimeAvailability.recovery,
      config: shell.isWorkspaceAvailable("config"),
      learning: shell.isWorkspaceAvailable("learning"),
      cardHidden: card.hidden, connectionActive: manager.state.active,
    };
  }
  capture.manager = manager;
  capture.guide = { bind: vi.fn(), render: vi.fn(), dispose: vi.fn(), focusAction: vi.fn() };
  const catalog = deferred<Catalog>();
  let computer: ReturnType<typeof createComputerAccessFeature>;
  const featureOptions = {
    dom: dom as never, shell, state,
    runtimeClient: {} as never,
    selectedEnvironmentId: () => environmentSelect.value,
    reloadModels: vi.fn(), reloadCatalog: vi.fn(), setMessageStatus: vi.fn(),
    onStateChange: () => computer?.runtimeAvailabilityChanged(),
  };
  const onboarding = createRuntimeOnboardingFeature(featureOptions);
  computer = createComputerAccessFeature({
    dom, runtimeClient: {}, getEnvironmentId: () => environmentSelect.value,
    isComputerAccessAvailable: () => shell.isWorkspaceAvailable("config"),
  });
  let savedEnvironment = "env-a";
  const actions = {
    savedEnvironmentId: () => savedEnvironment,
    saveEnvironmentId: (environment: string) => { savedEnvironment = environment; },
    suspendQueueRecovery: () => true,
    renderAgentPicker: vi.fn(), clearAttachments: vi.fn(), resetLiveRequestView: vi.fn(),
    applyConversationChrome: vi.fn(), renderMessages: vi.fn(),
    loadModels: vi.fn(async () => {
      onboarding.controller.beginCatalogLoad();
      try { onboarding.controller.applyCatalog(await catalog.promise); }
      catch (error) { onboarding.controller.catalogUnavailable(error); }
    }),
    loadAgentMode: vi.fn(async () => {}),
    loadRuntimeConfig: vi.fn(async () => true),
  };
  const bindings = createAppEventBindings({
    state, dom, shell, actions, documentRoot,
    modelSelector: {}, composerActions: {},
  });
  return { workspace, shell, dom, state, card, manager, onboarding, computer, bindings, actions,
    catalog, mountedVisibility, environmentObservations, observeAccess, guide: capture.guide };
}

afterEach(() => vi.clearAllMocks());

describe("onboarding access across construction and environment changes", () => {
  test("construction blocks computer access before binding or backend metadata", async () => {
    const f = fixture();
    expect(f.state.config).toBeNull();
    expect(f.guide.bind).not.toHaveBeenCalled();
    expect(f.guide.render).not.toHaveBeenCalled();
    expect(f.actions.loadModels).not.toHaveBeenCalled();
    expect(f.mountedVisibility).toEqual([true]);
    expect(f.manager.setActive).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.shell.isWorkspaceAvailable("config")).toBe(false);
    expect(f.shell.isWorkspaceAvailable("learning")).toBe(false);
    expect(await f.computer.load()).toBe(false);
    expect(f.computer.open()).toBe(false);
    expect(f.manager.load).not.toHaveBeenCalled();
  });

  test.each(["ready", "configuration recovery"])("leaving %s blocks the new environment before its catalog or change subscribers", async (prior) => {
    const f = fixture(); f.state.config = { backend: "runtime" };
    f.onboarding.controller.applyCatalog(readyCatalog);
    if (prior === "configuration recovery") f.onboarding.controller.applyCatalog(recoveryCatalog);
    expect(f.card.hidden).toBe(false);
    expect(f.manager.state.active).toBe(true);
    const changing = f.bindings.changeEnvironment("env-b", { restoreSession: false });
    expect(f.actions.loadModels).toHaveBeenCalledOnce();
    expect(f.bindings.isEnvironmentChanging()).toBe(true);
    expect(f.manager.environmentChanged).toHaveBeenCalledOnce();
    expect(f.environmentObservations).toEqual([{
      environment: "env-b", status: "checking", recovery: undefined,
      config: false, learning: false, cardHidden: true, connectionActive: false,
    }]);
    expect(await f.computer.load()).toBe(false);
    expect(f.manager.load).not.toHaveBeenCalled();
    f.catalog.resolve(readyCatalog);
    await expect(changing).resolves.toBe(true);
    expect(f.state.runtimeAvailability.status).toBe("ready");
    expect(f.shell.isWorkspaceAvailable("config")).toBe(true);
    expect(f.shell.isWorkspaceAvailable("learning")).toBe(true);
    expect(f.card.hidden).toBe(false);
    expect(f.manager.state.active).toBe(true);
    expect(await f.computer.load()).toBe(true);
    expect(f.manager.load).toHaveBeenCalledOnce();
  });

  test.each(["ready", "configuration recovery"])("a failed catalog after leaving %s stays blocked until the new environment becomes ready", async (prior) => {
    const f = fixture(); f.state.config = { backend: "runtime" };
    f.onboarding.controller.applyCatalog(readyCatalog);
    if (prior === "configuration recovery") f.onboarding.controller.applyCatalog(recoveryCatalog);
    const changing = f.bindings.changeEnvironment("env-b", { restoreSession: false });
    f.catalog.reject(new Error("Catalog offline"));
    await changing;
    expect(f.observeAccess()).toEqual({
      environment: "env-b", status: "error", recovery: undefined,
      config: false, learning: false, cardHidden: true, connectionActive: false,
    });
    expect(await f.computer.load()).toBe(false);
    expect(f.manager.load).not.toHaveBeenCalled();
    f.onboarding.controller.beginCatalogLoad();
    expect(f.shell.isWorkspaceAvailable("config")).toBe(false);
    f.onboarding.controller.applyCatalog(readyCatalog);
    expect(f.card.hidden).toBe(false);
    expect(f.manager.state.active).toBe(true);
  });

  test.each(["ready", "configuration recovery"])("same-environment checks preserve %s access", (prior) => {
    const f = fixture(); f.state.config = { backend: "runtime" };
    f.onboarding.controller.applyCatalog(readyCatalog);
    if (prior === "configuration recovery") f.onboarding.controller.applyCatalog(recoveryCatalog);
    f.manager.setActive.mockClear();
    f.onboarding.controller.beginCatalogLoad();
    expect(f.state.runtimeAvailability.status).toBe("checking");
    expect(f.shell.isWorkspaceAvailable("config")).toBe(true);
    expect(f.shell.isWorkspaceAvailable("learning")).toBe(true);
    expect(f.card.hidden).toBe(false);
    expect(f.manager.setActive).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.state.runtimeAvailability.recovery).toBe(prior === "configuration recovery" ? "configuration" : undefined);
    f.onboarding.controller.catalogUnavailable(new Error("Temporary catalog failure"));
    expect(f.card.hidden).toBe(false);
    expect(f.manager.state.active).toBe(true);
  });
});
