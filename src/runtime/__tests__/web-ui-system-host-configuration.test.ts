import { beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser onboarding policy has no declaration surface.
import { createOnboardingWorkspaceAccess } from "../../web-ui/app/components/onboarding-workspace-access.js";

const state = vi.hoisted(() => ({
  options: {} as Record<string, any>,
  hostOptions: {} as Record<string, any>,
  noticeOptions: {} as Record<string, any>,
  noticeRender: vi.fn(),
  homeOptions: {} as Record<string, any>,
  homeRender: vi.fn(),
  activateCategory: vi.fn(),
  commit: vi.fn(),
  prepare: vi.fn(),
  host: { setActive: vi.fn(), load: vi.fn(), state: { snapshot: null } },
}));

vi.mock("../../web-ui/app/components/config-workspace.js", () => ({
  createConfigWorkspace: (options: Record<string, any>) => {
    state.options = options;
    return {
      prepareDiscardChanges: state.prepare,
      activateCategory: state.activateCategory,
    };
  },
}));
vi.mock("../../web-ui/app/components/system-host/manager.js", () => ({
  createSystemHostConnectionManager: (options: Record<string, any>) => {
    state.hostOptions = options;
    return state.host;
  },
}));
vi.mock("../../web-ui/app/components/system-host/setup-notice.js", () => ({
  createSystemHostSetupNotice: (options: Record<string, any>) => {
    state.noticeOptions = options;
    return { render: state.noticeRender };
  },
}));
vi.mock("../../web-ui/app/components/home-guidance/home-guidance.js", () => ({
  createHomeGuidance: (options: Record<string, any>) => {
    state.homeOptions = options;
    return { render: state.homeRender };
  },
}));
vi.mock("../../web-ui/app/components/model-setup/wizard.js", () => ({
  createModelSetupWizard: () => ({ isOpen: () => false }),
}));
vi.mock("../../web-ui/app/components/runtime-config-activation.js", () => ({
  createRuntimeConfigActivation: () => ({}),
}));
vi.mock("../../web-ui/app/components/long-term-memory-setup.js", () => ({
  createLongTermMemorySetup: () => ({ mount: vi.fn() }),
}));
vi.mock("../../web-ui/app/components/plugins/manager.js", () => ({
  createPluginManager: () => ({ hasConfigurationDraft: () => false }),
}));
vi.mock("../../web-ui/app/components/long-term-memory/manager.js", () => ({
  createLongTermMemoryManager: () => ({ mount: vi.fn() }),
}));
vi.mock("../../web-ui/app/controllers/long-term-memory/controller.js", () => ({
  createLongTermMemoryController: () => ({}),
}));

// @ts-expect-error Browser composition module has no public declaration.
import { createConfigurationFeature } from "../../web-ui/app/configuration-feature.js";

beforeEach(() => {
  vi.resetAllMocks();
  state.prepare.mockReturnValue(state.commit);
});

function harness(runtimeReady = true) {
  let environmentId = "prod";
  const workspaceAccess = createOnboardingWorkspaceAccess({ dom: {}, backendAllows: () => true });
  workspaceAccess.update({ status: runtimeReady ? "ready" : "setup_required" });
  const client = {
    getSystemHostConnection: vi.fn(),
    connectLocalSystemHost: vi.fn(),
    createSystemHostPairing: vi.fn(),
    downloadSystemHostSetup: vi.fn(),
    revokeSystemHostConnection: vi.fn(),
    supportsSystemHostConnection: vi.fn(() => true),
  };
  const homeWorkspacePanel = { hidden: true };
  const openHome = vi.fn(() => {
    homeWorkspacePanel.hidden = false;
  });
  const openPlugins = vi.fn();
  const feature = createConfigurationFeature({
    dom: {
      configDashboard: { parentElement: {} },
      homeWorkspacePanel,
      homeWorkspaceButton: { click: openHome },
      pluginsWorkspaceButton: { click: openPlugins },
    },
    runtimeClient: client,
    selectedEnvironmentId: () => environmentId,
    isRuntimeReady: () => runtimeReady,
    isComputerAccessAvailable: () => workspaceAccess.isAvailable("config"),
  });
  function setRuntimeAvailability(availability: { status: string; recovery?: string }) {
    runtimeReady = availability.status === "ready";
    workspaceAccess.update(availability);
    feature.renderHomeGuidance();
  }
  return {
    feature,
    client,
    openHome,
    openPlugins,
    setRuntimeAvailability,
    setRuntimeReady(value: boolean) { setRuntimeAvailability({ status: value ? "ready" : "setup_required" }); },
    changeEnvironment: () => {
      environmentId = "dev";
    },
  };
}

test("configuration navigation keeps the existing deferred commit contract", () => {
  const { feature } = harness();
  const commit = feature.prepareDiscardChanges("leave configuration");
  expect(state.commit).not.toHaveBeenCalled();
  commit();
  expect(state.commit).toHaveBeenCalledOnce();
});

test("rejected navigation retains the visible setup flow", () => {
  const { feature } = harness();
  state.prepare.mockReturnValue(null);
  expect(feature.prepareDiscardChanges("leave configuration")).toBeNull();
  expect(state.host.setActive).not.toHaveBeenCalled();
});

test("configuration composes one shared connection across environment switches", async () => {
  const { feature, client, changeEnvironment } = harness();
  await feature.refreshComputerAccess();
  expect(state.host.load).toHaveBeenCalledOnce();
  expect(state.options).not.toHaveProperty("hostConnection");
  await state.hostOptions.loadConnection();
  changeEnvironment();
  await state.hostOptions.loadConnection();
  await state.hostOptions.downloadSetup("linux");
  await state.hostOptions.connectLocal();
  await state.hostOptions.createPairing();
  await state.hostOptions.revokeConnection();
  expect(client.getSystemHostConnection.mock.calls).toEqual([[], []]);
  expect(client.downloadSystemHostSetup).toHaveBeenCalledWith("linux");
  expect(client.connectLocalSystemHost).toHaveBeenCalledWith();
  expect(client.createSystemHostPairing).toHaveBeenCalledWith();
  expect(client.revokeSystemHostConnection).toHaveBeenCalledWith();
});

test("setup notice consumes the existing manager without independent requests", () => {
  const { client } = harness();
  expect(state.noticeOptions.getConnectionState()).toBe(state.host.state);
  expect(state.noticeOptions.supportsConnection()).toBe(true);
  state.hostOptions.onChange();
  expect(state.noticeRender).toHaveBeenCalledOnce();
  expect(client.getSystemHostConnection).not.toHaveBeenCalled();
  state.noticeOptions.refreshConnection();
  expect(state.host.load).toHaveBeenCalledWith(true);
  expect(client.getSystemHostConnection).not.toHaveBeenCalled();
});

test("setup link and public entry point navigate Home without a Computer config category", () => {
  const { feature, openHome } = harness();
  state.noticeOptions.onOpen();
  feature.openComputerSetup();
  expect(openHome).toHaveBeenCalledTimes(2);
  expect(state.activateCategory).not.toHaveBeenCalled();
});

test("setup link respects rejected Home navigation", () => {
  const { feature, openHome } = harness();
  openHome.mockImplementation(() => {});
  expect(feature.openComputerSetup()).toBe(false);
  expect(openHome).toHaveBeenCalledOnce();
  expect(state.activateCategory).not.toHaveBeenCalled();
});

test("Home suggestions leave computer status and refresh with the permanent Home card", () => {
  const { client } = harness();
  expect(state.homeOptions.getConnectionState()).toBeNull();
  expect(state.homeOptions.supportsConnection()).toBe(false);
  state.hostOptions.onChange();
  expect(state.homeRender).toHaveBeenCalledOnce();
  expect(state.noticeRender).toHaveBeenCalledOnce();
  state.homeOptions.refreshConnection();
  expect(state.host.load).not.toHaveBeenCalled();
  expect(client.getSystemHostConnection).not.toHaveBeenCalled();
});

test("Home plugin suggestion opens the independent Plugins workspace", () => {
  const { openPlugins } = harness();
  state.homeOptions.onOpen("plugins");
  expect(openPlugins).toHaveBeenCalledOnce();
  expect(state.activateCategory).not.toHaveBeenCalled();
});


test("configuration forwards initial onboarding access to Home and its chat notice", async () => {
  const { feature, openHome, setRuntimeReady } = harness(false);
  expect(state.noticeOptions.supportsConnection()).toBe(false);
  expect(await feature.refreshComputerAccess()).toBe(false);
  expect(feature.openComputerSetup()).toBe(false);
  expect(state.host.load).not.toHaveBeenCalled();
  expect(openHome).not.toHaveBeenCalled();

  setRuntimeReady(true);
  expect(state.host.setActive).toHaveBeenLastCalledWith(true);
  expect(state.noticeOptions.supportsConnection()).toBe(true);
  await feature.refreshComputerAccess();
  expect(state.host.load).toHaveBeenCalledOnce();

  setRuntimeReady(false);
  expect(state.host.setActive).toHaveBeenLastCalledWith(false);
  expect(state.noticeOptions.supportsConnection()).toBe(false);
  expect(state.homeRender).toHaveBeenCalledTimes(2);
});


test("computer access and notice stay eligible during catalog recovery while Home guidance sees exact readiness", async () => {
  const { feature, openHome, setRuntimeAvailability } = harness();
  expect(state.homeOptions.isRuntimeReady()).toBe(true);
  for (const availability of [
    { status: "checking" }, { status: "error" },
    { status: "setup_required", recovery: "configuration" },
  ]) {
    setRuntimeAvailability(availability);
    expect(state.homeOptions.isRuntimeReady()).toBe(false);
    expect(state.host.setActive).toHaveBeenLastCalledWith(true);
    expect(state.noticeOptions.supportsConnection()).toBe(true);
    const loads = state.host.load.mock.calls.length;
    await feature.refreshComputerAccess();
    expect(state.host.load).toHaveBeenCalledTimes(loads + 1);
    await state.noticeOptions.refreshConnection();
    expect(state.host.load).toHaveBeenLastCalledWith(true);
    expect(state.host.load).toHaveBeenCalledTimes(loads + 2);
    feature.openComputerSetup();
    state.noticeOptions.onOpen();
  }
  expect(openHome).toHaveBeenCalledTimes(6);
  expect(state.host.setActive).not.toHaveBeenCalledWith(false);
});
