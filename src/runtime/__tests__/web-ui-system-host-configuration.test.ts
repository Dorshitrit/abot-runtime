import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  options: {} as Record<string, any>,
  hostOptions: {} as Record<string, any>,
  noticeOptions: {} as Record<string, any>,
  noticeRender: vi.fn(),
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
vi.mock("../../web-ui/app/components/model-setup/wizard.js", () => ({
  createModelSetupWizard: () => ({ isOpen: () => false }),
}));
vi.mock("../../web-ui/app/components/runtime-config-activation.js", () => ({
  createRuntimeConfigActivation: () => ({}),
}));
vi.mock("../../web-ui/app/components/long-term-memory-setup.js", () => ({
  createLongTermMemorySetup: () => ({}),
}));
vi.mock("../../web-ui/app/components/plugins/manager.js", () => ({
  createPluginManager: () => ({}),
}));
vi.mock("../../web-ui/app/components/long-term-memory/manager.js", () => ({
  createLongTermMemoryManager: () => ({}),
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

function harness() {
  let environmentId = "prod";
  const client = {
    getSystemHostConnection: vi.fn(),
    downloadSystemHostSetup: vi.fn(),
    revokeSystemHostConnection: vi.fn(),
    supportsSystemHostConnection: vi.fn(() => true),
  };
  const configWorkspacePanel = { hidden: true };
  const openConfig = vi.fn(() => {
    configWorkspacePanel.hidden = false;
  });
  const feature = createConfigurationFeature({
    dom: {
      configDashboard: { parentElement: {} },
      configWorkspacePanel,
      configWorkspaceButton: { click: openConfig },
    },
    runtimeClient: client,
    selectedEnvironmentId: () => environmentId,
  });
  return {
    feature,
    client,
    openConfig,
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
  const { client, changeEnvironment } = harness();
  expect(state.options.hostConnection).toBe(state.host);
  await state.hostOptions.loadConnection();
  changeEnvironment();
  await state.hostOptions.loadConnection();
  await state.hostOptions.downloadSetup("windows");
  await state.hostOptions.revokeConnection();
  expect(client.getSystemHostConnection.mock.calls).toEqual([[], []]);
  expect(client.downloadSystemHostSetup).toHaveBeenCalledWith("windows");
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

test("setup link opens the Computer category through the existing navigation", () => {
  const { openConfig } = harness();
  state.noticeOptions.onOpen();
  expect(openConfig).toHaveBeenCalledOnce();
  expect(state.activateCategory).toHaveBeenCalledWith("computer");
});

test("setup link respects rejected configuration navigation", () => {
  const { openConfig } = harness();
  openConfig.mockImplementation(() => {});
  state.noticeOptions.onOpen();
  expect(state.activateCategory).not.toHaveBeenCalled();
});
