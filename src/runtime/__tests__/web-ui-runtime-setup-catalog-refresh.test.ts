import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntimeOnboardingController } from "../../web-ui/app/controllers/runtime-onboarding-controller.js";
import { createRuntimeSelectionController, type RuntimeSelectionControllerDependencies } from "../../web-ui/app/controllers/runtime-selection-controller.js";
// @ts-expect-error Browser composition module has no declaration.
import { createConfigurationFeature } from "../../web-ui/app/configuration-environment-refresh.js";
import { createGuideHarness } from "./support/runtime-setup-guide-harness.js";

vi.mock("../../web-ui/app/configuration-feature.js", () => ({
  createConfigurationFeature: () => ({ load: async () => true }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function element() {
  const options: Array<{ value: string; textContent: string }> = [];
  return {
    value: "", innerHTML: "", textContent: "", hidden: false, disabled: false,
    title: "", options, classList: { toggle: vi.fn() },
    setAttribute: vi.fn(), focus: vi.fn(), querySelectorAll: () => [],
    append: vi.fn(),
    appendChild: (option: { value: string; textContent: string }) => options.push(option),
  };
}

const readyCatalog = {
  defaultProfileId: "applied-model",
  profiles: [{ id: "applied-model", label: "Applied model" }],
  availability: { status: "ready" },
};
const oldConfigError = new Error("Invalid runtime config: requestRunner.configRef is required");

function fixture(listModels: (environment: string) => Promise<Record<string, unknown>>) {
  vi.stubGlobal("document", { createElement: element });
  const applied = deferred<void>();
  const applySetup = vi.fn(async () => {
    await applied.promise;
    return { activation: { status: "ready" as const } };
  });
  const environmentSelect = { ...element(), value: "dev" };
  const wizard = createGuideHarness({ applySetup, getEnvironmentId: () => environmentSelect.value });
  const state: RuntimeSelectionControllerDependencies["state"] & {
    runtimeAvailability: { status: string };
  } = {
    runtimeAvailability: { status: "setup_required" },
    config: { defaultEnvironmentId: "dev" },
    modelProfiles: [], defaultModelProfileId: "", pinnedSessionIds: [],
    sessionModes: {}, sessionModels: {}, lastModelByEnvironment: {},
    agentMode: "reasoning", supportedAgentModes: ["fast", "reasoning", "deep"],
    agentModeMenuOpen: false, permissionModeMenuOpen: false,
    agentPickerOpen: false, currentSessionId: "",
  };
  let reload = async () => { await selection.loadModels(); };
  let checkAgain: () => void | Promise<void> = () => {};
  const onboarding = createRuntimeOnboardingController({
    state,
    guide: {
      ...wizard.guide,
      bind(options) {
        checkAgain = options?.onCheckAgain || (() => {});
        wizard.guide.bind(options);
      },
    },
    reloadModels: () => reload(),
    setMessageStatus: vi.fn(),
  });
  const selection = createRuntimeSelectionController({
    state,
    dom: {
      environmentSelect, modelSelect: element(),
      agentPickerButton: element(), agentPickerMenu: element(),
      permissionModeButton: element(), permissionModeMenu: element(),
      agentModeButton: element(), agentModeMenu: element(),
    },
    preferences: {
      loadPinnedSessions: () => [], loadSessionModes: () => ({}),
      saveSessionModes: vi.fn(), loadLastToolPermissionMode: () => "ask",
      saveLastToolPermissionMode: vi.fn(),
      loadModelPreferences: () => ({ sessionModels: {}, lastModelByEnvironment: {} }),
      saveModelPreferences: vi.fn(),
    },
    modelSelector: { sync: vi.fn() },
    client: { listModels, getAgentMode: vi.fn(), setAgentMode: vi.fn() },
    recordControlEvent: vi.fn(), onAttachmentPolicyChange: vi.fn(),
    onModelCatalogLoading: onboarding.beginCatalogLoad,
    onModelCatalogLoaded: onboarding.applyCatalog,
    onModelCatalogUnavailable: onboarding.catalogUnavailable,
  });
  async function startApplying() {
    onboarding.bind();
    await wizard.ready();
    wizard.changeProvider("ollama");
    wizard.submit();
    wizard.inputModel("applied-model");
    wizard.submit();
    await wizard.ready();
    await wizard.skipToReview();
    wizard.click("apply");
    expect(applySetup).toHaveBeenCalledOnce();
  }
  return {
    state, wizard, applied, onboarding, selection, startApplying, environmentSelect,
    checkAgain: () => checkAgain(),
    setReload: (callback: () => Promise<void>) => { reload = callback; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("setup completion catalog refresh", () => {
  test.each(["failure", "success"])("supersedes a pre-apply catalog read with late %s", async (outcome) => {
    const oldCatalog = deferred<Record<string, unknown>>();
    const listModels = vi.fn()
      .mockImplementationOnce(() => oldCatalog.promise)
      .mockResolvedValue(readyCatalog);
    const setup = fixture(listModels);
    await setup.startApplying();
    const oldRead = setup.selection.loadModels();
    expect(setup.state.runtimeAvailability.status).toBe("checking");
    setup.applied.resolve();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(setup.onboarding.isReady()).toBe(true));
    if (outcome === "failure") oldCatalog.reject(oldConfigError);
    else oldCatalog.resolve({ profiles: [], availability: { status: "setup_required" } });
    await oldRead;
    expect(setup.state.runtimeAvailability).toEqual({ status: "ready" });
    expect(setup.state.defaultModelProfileId).toBe("applied-model");
    expect(setup.onboarding.submissionBlock()).toBeNull();
    expect(setup.wizard.container.hidden).toBe(true);
  });

  test("ignores an older reload rejection after the applied configuration is ready", async () => {
    const oldReload = deferred<void>();
    const listModels = vi.fn().mockResolvedValue(readyCatalog);
    const setup = fixture(listModels);
    const reload = vi.fn()
      .mockImplementationOnce(() => oldReload.promise)
      .mockImplementation(async () => { await setup.selection.loadModels(); });
    setup.setReload(reload);
    await setup.startApplying();
    const oldCheck = setup.checkAgain();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    setup.applied.resolve();
    await vi.waitFor(() => expect(setup.onboarding.isReady()).toBe(true));
    oldReload.reject(oldConfigError);
    await oldCheck;
    expect(reload).toHaveBeenCalledTimes(2);
    expect(listModels).toHaveBeenCalledOnce();
    expect(setup.state.runtimeAvailability).toEqual({ status: "ready" });
    expect(setup.onboarding.submissionBlock()).toBeNull();
  });

  test.each([false, true])("handles config refresh failure after environment replacement: %s", async (environmentChanged) => {
    const webConfig = deferred<Record<string, unknown>>();
    const listModels = vi.fn().mockResolvedValue(readyCatalog);
    const setup = fixture(listModels);
    const loadWebConfig = vi.fn(() => webConfig.promise);
    const configuration = createConfigurationFeature({
      state: setup.state, dom: { environmentSelect: setup.environmentSelect },
      selection: setup.selection, runtimeClient: { loadWebConfig },
      onConfigurationApplied: () => setup.selection.loadModels(),
    });
    setup.setReload(() => configuration.reloadAppliedEnvironmentModels());
    await setup.startApplying();
    setup.applied.resolve();
    await vi.waitFor(() => expect(loadWebConfig).toHaveBeenCalledOnce());
    const appliedCheck = setup.checkAgain();
    if (environmentChanged) {
      setup.environmentSelect.value = "prod";
      await setup.selection.loadModels();
      expect(setup.onboarding.isReady()).toBe(true);
    }
    webConfig.reject(oldConfigError);
    await appliedCheck;
    if (!environmentChanged) {
      expect(setup.state.runtimeAvailability).toMatchObject({
        status: "error", message: oldConfigError.message,
      });
      expect(listModels).not.toHaveBeenCalled();
      return;
    }
    expect(setup.state.runtimeAvailability).toEqual({ status: "ready" });
    expect(setup.onboarding.submissionBlock()).toBeNull();
    expect(listModels).toHaveBeenCalledExactlyOnceWith("prod");
    setup.setReload(async () => { await setup.selection.loadModels(); });
    await setup.checkAgain();
    expect(listModels).toHaveBeenCalledTimes(2);
  });
});
