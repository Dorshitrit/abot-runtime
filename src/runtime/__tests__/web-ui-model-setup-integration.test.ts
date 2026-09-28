import { beforeEach, expect, test, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  workspace: {
    beginExternalRuntimeMutation: vi.fn(),
    endExternalRuntimeMutation: vi.fn(),
    prepareDiscardChanges: vi.fn(),
    refreshAfterExternalRuntimeMutation: vi.fn(),
    selectModel: vi.fn(),
    focusSelectedModel: vi.fn(),
    setStatus: vi.fn(),
  },
  wizard: { open: vi.fn(), isOpen: vi.fn() },
  activation: { markPending: vi.fn(), markApplied: vi.fn() },
  memory: { load: vi.fn(), mount: vi.fn() },
  memoryOptions: {} as Record<string, any>,
  plugins: { markApplied: vi.fn() },
  workspaceOptions: {} as Record<string, any>,
  wizardOptions: {} as Record<string, any>,
}));

vi.mock("../../web-ui/app/components/config-workspace.js", () => ({
  createConfigWorkspace: (options: Record<string, any>) => {
    fixtures.workspaceOptions = options;
    return fixtures.workspace;
  },
}));
vi.mock("../../web-ui/app/components/model-setup/wizard.js", () => ({
  createModelSetupWizard: (options: Record<string, any>) => {
    fixtures.wizardOptions = options;
    return fixtures.wizard;
  },
}));
vi.mock("../../web-ui/app/components/runtime-config-activation.js", () => ({
  createRuntimeConfigActivation: () => fixtures.activation,
}));
vi.mock("../../web-ui/app/components/long-term-memory-setup.js", () => ({
  createLongTermMemorySetup: (options: Record<string, any>) => {
    fixtures.memoryOptions = options;
    return fixtures.memory;
  },
}));
vi.mock("../../web-ui/app/components/plugins/manager.js", () => ({
  createPluginManager: () => fixtures.plugins,
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
  fixtures.workspace.beginExternalRuntimeMutation.mockReturnValue(true);
  fixtures.workspace.refreshAfterExternalRuntimeMutation.mockResolvedValue(
    true,
  );
  fixtures.workspace.selectModel.mockReturnValue(true);
  fixtures.workspace.prepareDiscardChanges.mockReturnValue({ commit: vi.fn() });
  fixtures.memory.load.mockResolvedValue(true);
  fixtures.wizard.isOpen.mockReturnValue(false);
});

function setup() {
  const status = { textContent: "" };
  const root = {};
  const client = {
    saveConfigFile: vi.fn(),
    loadModelSetup: vi.fn(),
    addRuntimeModel: vi.fn(),
    removeRuntimeModel: vi.fn(),
    applyRuntimeConfiguration: vi.fn(),
    enableLongTermMemory: vi.fn(),
    disableLongTermMemory: vi.fn(),
  };
  const onConfigurationApplied = vi.fn();
  const feature = createConfigurationFeature({
    dom: { configDashboard: { parentElement: root }, configStatus: status },
    runtimeClient: client,
    selectedEnvironmentId: () => "dev",
    recordControlEvent: vi.fn(),
    onConfigurationApplied,
  });
  return { feature, client, status, root, onConfigurationApplied };
}

test("successful Memory changes require a runtime restart", async () => {
  const { client } = setup();
  const enabled = { enabled: true };
  const disabled = { enabled: false };
  client.enableLongTermMemory.mockResolvedValue(enabled);
  client.disableLongTermMemory.mockResolvedValue(disabled);

  expect(
    await fixtures.memoryOptions.enableMemory({ model: "embedding" }, "dev"),
  ).toBe(enabled);
  expect(client.enableLongTermMemory).toHaveBeenCalledWith({
    environmentId: "dev",
    model: "embedding",
  });
  expect(await fixtures.memoryOptions.disableMemory("dev")).toBe(disabled);
  expect(client.disableLongTermMemory).toHaveBeenCalledWith("dev");
  expect(fixtures.activation.markPending).toHaveBeenCalledTimes(2);

  client.enableLongTermMemory.mockRejectedValueOnce(new Error("save failed"));
  await expect(fixtures.memoryOptions.enableMemory({}, "dev")).rejects.toThrow(
    "save failed",
  );
  expect(fixtures.activation.markPending).toHaveBeenCalledTimes(2);
});

test("the provider shortcut honors draft/busy guards and opens outside the dashboard", async () => {
  const { root } = setup();
  fixtures.workspace.beginExternalRuntimeMutation.mockReturnValueOnce(false);
  await fixtures.workspaceOptions.onAddModel({ providerId: "my-connection" });
  expect(fixtures.wizard.open).not.toHaveBeenCalled();
  expect(fixtures.workspace.endExternalRuntimeMutation).not.toHaveBeenCalled();

  await fixtures.workspaceOptions.onAddModel({ providerId: "my-connection" });
  expect(fixtures.wizardOptions.root).toBe(root);
  expect(fixtures.workspace.endExternalRuntimeMutation).toHaveBeenCalledOnce();
  expect(fixtures.wizard.open).toHaveBeenCalledWith({
    providerId: "my-connection",
  });
  fixtures.wizard.isOpen.mockReturnValue(true);
  await fixtures.workspaceOptions.onAddModel({});
  expect(fixtures.wizard.open).toHaveBeenCalledOnce();
});

test("an open wizard blocks programmatic workspace/environment changes", () => {
  const { feature, status } = setup();
  fixtures.wizard.isOpen.mockReturnValue(true);
  expect(feature.prepareDiscardChanges("change environment")).toBeNull();
  expect(fixtures.workspace.prepareDiscardChanges).not.toHaveBeenCalled();
  expect(status.textContent).toContain("Finish or cancel");
  fixtures.wizard.isOpen.mockReturnValue(false);
  expect(feature.prepareDiscardChanges("leave configuration")).not.toBeNull();
  expect(fixtures.workspace.prepareDiscardChanges).toHaveBeenCalledWith(
    "leave configuration",
  );
});

test("successful completion refreshes provider choices and selects the new model before focus", async () => {
  const { client, onConfigurationApplied } = setup();
  const options = fixtures.wizardOptions;
  const model = { profileId: "second-model", providerId: "my-connection" };
  options.onSaved(model);
  expect(fixtures.activation.markPending).toHaveBeenCalledOnce();
  expect(fixtures.activation.markApplied).not.toHaveBeenCalled();

  await options.loadSetup();
  await options.saveModel({
    profileId: model.profileId,
    providerId: model.providerId,
    model: "fixture",
  });
  await options.applySetup();
  expect(client.loadModelSetup).toHaveBeenCalledWith("dev");
  expect(client.addRuntimeModel).toHaveBeenCalledWith(
    {
      profileId: "second-model",
      providerId: "my-connection",
      model: "fixture",
    },
    "dev",
  );
  expect(client.applyRuntimeConfiguration).toHaveBeenCalledWith("dev");
  expect(await options.onComplete(model)).toBe(true);
  expect(fixtures.activation.markApplied).toHaveBeenCalledOnce();
  expect(fixtures.memory.load).toHaveBeenCalledOnce();
  expect(fixtures.plugins.markApplied).toHaveBeenCalledOnce();
  expect(fixtures.workspace.selectModel).toHaveBeenCalledWith("second-model");
  expect(onConfigurationApplied).toHaveBeenCalledOnce();
  expect(fixtures.workspace.focusSelectedModel).not.toHaveBeenCalled();

  options.onClosed({ completed: false });
  expect(fixtures.workspace.focusSelectedModel).not.toHaveBeenCalled();
  options.onClosed({ completed: true });
  expect(fixtures.workspace.focusSelectedModel).toHaveBeenCalledOnce();
});

test("post-Apply dashboard failure still updates the chat catalog and remains retryable", async () => {
  const { onConfigurationApplied } = setup();
  fixtures.workspace.refreshAfterExternalRuntimeMutation.mockResolvedValueOnce(
    false,
  );
  expect(await fixtures.wizardOptions.onComplete({ profileId: "added" })).toBe(
    false,
  );
  expect(onConfigurationApplied).toHaveBeenCalledOnce();
  expect(fixtures.memory.load).not.toHaveBeenCalled();
  expect(fixtures.workspace.selectModel).not.toHaveBeenCalled();

  fixtures.memory.load.mockResolvedValueOnce(false);
  expect(await fixtures.wizardOptions.onComplete({ profileId: "added" })).toBe(
    false,
  );
  expect(fixtures.workspace.selectModel).not.toHaveBeenCalled();
  expect(await fixtures.wizardOptions.onComplete({ profileId: "added" })).toBe(
    true,
  );
  expect(fixtures.workspace.selectModel).toHaveBeenCalledWith("added");
  expect(onConfigurationApplied).toHaveBeenCalledTimes(3);
});

test("deferred activation reveals the saved model without claiming it is active", async () => {
  const { onConfigurationApplied } = setup();
  const model = { profileId: "saved-model" };
  fixtures.wizardOptions.onSaved(model);
  expect(await fixtures.wizardOptions.onDeferred(model)).toBe(true);
  expect(fixtures.workspace.selectModel).toHaveBeenCalledWith("saved-model");
  expect(fixtures.activation.markPending).toHaveBeenCalledOnce();
  expect(fixtures.activation.markApplied).not.toHaveBeenCalled();
  expect(fixtures.memory.load).not.toHaveBeenCalled();
  expect(onConfigurationApplied).not.toHaveBeenCalled();

  fixtures.workspace.selectModel.mockClear();
  fixtures.workspace.refreshAfterExternalRuntimeMutation.mockResolvedValueOnce(
    false,
  );
  expect(await fixtures.wizardOptions.onDeferred(model)).toBe(false);
  expect(fixtures.workspace.selectModel).not.toHaveBeenCalled();
});

test("Configuration composition preserves the loaded revision through the transport boundary", async () => {
  const { client } = setup();
  const result = { file: { revision: "saved-revision" } };
  client.saveConfigFile.mockResolvedValue(result);
  const input = {
    kind: "runtime",
    id: "runtime",
    config: { webUi: {} },
    expectedRevision: "loaded-revision",
  };
  expect(await fixtures.workspaceOptions.saveFile(input)).toBe(result);
  expect(client.saveConfigFile).toHaveBeenCalledWith({
    ...input,
    environmentId: "dev",
  });
  expect(fixtures.activation.markPending).toHaveBeenCalledOnce();
});

test("model removal passes the loaded root revision and remains pending explicit Apply", async () => {
  vi.stubGlobal("window", { confirm: () => true });
  try {
    const { client } = setup();
    const model = {
      profileId: "extra-model",
      label: "Extra model",
      expectedRevision: "loaded-root-revision",
    };
    fixtures.wizard.isOpen.mockReturnValueOnce(true);
    await fixtures.workspaceOptions.onRemoveModel(model);
    expect(client.removeRuntimeModel).not.toHaveBeenCalled();
    await fixtures.workspaceOptions.onRemoveModel(model);
    expect(client.removeRuntimeModel).toHaveBeenCalledExactlyOnceWith(
      { profileId: model.profileId, expectedRevision: model.expectedRevision },
      "dev",
    );
    expect(
      fixtures.workspace.beginExternalRuntimeMutation,
    ).toHaveBeenCalledWith("model removal");
    expect(
      fixtures.workspace.endExternalRuntimeMutation,
    ).toHaveBeenCalledOnce();
    expect(fixtures.activation.markPending).toHaveBeenCalledOnce();
    expect(client.applyRuntimeConfiguration).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
