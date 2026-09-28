import { expect, test, vi } from "vitest";
// @ts-expect-error Browser JavaScript has no declaration surface.
import { createConfigWorkspace } from "../../web-ui/app/components/config-workspace.js";
// @ts-expect-error Browser JavaScript has no declaration surface.
import { createModelRemovalController } from "../../web-ui/app/components/config-workspace/model-removal.js";

function element() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  return {
    innerHTML: "",
    textContent: "",
    className: "",
    disabled: false,
    inert: false,
    setAttribute() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(name: string, listener: (event: unknown) => void) {
      listeners.set(name, [...(listeners.get(name) || []), listener]);
    },
    dispatch(name: string, target: unknown) {
      for (const listener of listeners.get(name) || []) listener({ target });
    },
  };
}
function action(configAction: string, fields: Record<string, unknown> = {}) {
  const target = {
    dataset: { configAction, ...fields },
    closest: () => target,
    matches: () => false,
    value: "",
  };
  return target;
}
function registrationDashboard(profileIds: string[]) {
  return {
    dashboard: {
      files: {
        runtime: {
          config: {
            models: {
              profiles: Object.fromEntries(profileIds.map((id) => [id, {}])),
            },
          },
        },
      },
    },
  };
}
function fixture() {
  const dom = {
    configDashboard: element(),
    configStatus: element(),
    refreshConfigButton: element(),
  };
  const payload = {
    dashboard: {
      files: {
        runtime: {
          id: "runtime",
          kind: "runtime",
          config: { models: { profiles: { declared: {} } } },
          revision: "root-revision",
        },
        models: [
          {
            id: "declared",
            kind: "model",
            registered: true,
            config: { label: "Declared model" },
            revision: "linked-revision",
          },
          {
            id: "orphan",
            kind: "model",
            registered: false,
            config: { label: "Orphan file" },
            revision: "orphan-revision",
          },
        ],
      },
    },
  };
  const onRemoveModel = vi.fn();
  const workspace = createConfigWorkspace({
    dom,
    onRemoveModel,
    eventTarget: element(),
    loadDashboard: vi.fn(async () => structuredClone(payload)),
    saveFile: vi.fn(),
    recordControlEvent: vi.fn(),
    confirmDiscard: () => true,
    memorySetup: { load: vi.fn(), mount: vi.fn() },
    memoryManagement: { load: vi.fn(), mount: vi.fn() },
  });
  workspace.bind();
  return { workspace, dom, onRemoveModel };
}
function controllerFixture() {
  const options = {
    removeModel: vi.fn(async () => ({ restartRequired: true })),
    loadDashboard: vi.fn(async () => registrationDashboard(["declared"])),
    getEnvironmentId: vi.fn(() => "prod"),
    beginRuntimeMutation: vi.fn(() => true),
    endRuntimeMutation: vi.fn(),
    refreshRuntimeConfig: vi.fn(async () => true),
    onSaved: vi.fn(),
    setStatus: vi.fn(),
    confirmRemoval: vi.fn(() => true),
  };
  const controller = createModelRemovalController(options);
  return { options, controller };
}
const selected = {
  profileId: "declared",
  label: "Declared model",
  expectedRevision: "root-revision",
};

test("registered removal passes the root revision and an orphan remains visible without a removal action", async () => {
  const { workspace, dom, onRemoveModel } = fixture();
  await workspace.load();
  expect(dom.configDashboard.innerHTML).toContain(
    'data-config-action="remove-model"',
  );
  expect(dom.configDashboard.innerHTML).toContain("Not registered");
  dom.configDashboard.dispatch(
    "click",
    action("remove-model", { id: "declared" }),
  );
  expect(onRemoveModel).toHaveBeenCalledWith(selected);
  workspace.selectModel("orphan");
  expect(dom.configDashboard.innerHTML).toContain("Not registered");
  expect(dom.configDashboard.innerHTML).not.toContain(
    'data-config-action="remove-model"',
  );
  dom.configDashboard.dispatch(
    "click",
    action("remove-model", { id: "orphan" }),
  );
  expect(onRemoveModel).toHaveBeenCalledOnce();
});

test("dirty Configuration blocks model removal before confirmation or persistence", async () => {
  const { workspace, dom } = fixture();
  await workspace.load();
  const field = action("field", {
    kind: "runtime",
    id: "runtime",
    path: JSON.stringify(["logging", "enabled"]),
    valueType: "string",
  });
  field.value = "changed";
  dom.configDashboard.dispatch("input", field);
  const { options } = controllerFixture();
  const controller = createModelRemovalController({
    ...options,
    beginRuntimeMutation: workspace.beginExternalRuntimeMutation,
  });
  await expect(controller.remove(selected)).resolves.toBe(false);
  expect(options.removeModel).not.toHaveBeenCalled();
  expect(options.confirmRemoval).not.toHaveBeenCalled();
  expect(dom.configStatus.textContent).toContain("Save or reset");
});

test("confirms the selected model and marks pending only after committed removal", async () => {
  const { controller, options } = controllerFixture();
  await expect(controller.remove(selected)).resolves.toBe(true);
  expect(options.confirmRemoval).toHaveBeenCalledWith(
    expect.stringContaining("Declared model"),
  );
  expect(options.removeModel).toHaveBeenCalledWith(
    { profileId: "declared", expectedRevision: "root-revision" },
    "prod",
  );
  expect(options.onSaved).toHaveBeenCalledOnce();
  expect(options.refreshRuntimeConfig).toHaveBeenCalledOnce();
  expect(options.endRuntimeMutation).toHaveBeenCalledOnce();
});

test("cancellation releases the mutation guard without writing", async () => {
  const { controller, options } = controllerFixture();
  options.confirmRemoval.mockReturnValue(false);
  await expect(controller.remove(selected)).resolves.toBe(false);
  expect(options.removeModel).not.toHaveBeenCalled();
  expect(options.onSaved).not.toHaveBeenCalled();
  expect(options.endRuntimeMutation).toHaveBeenCalledOnce();
});

test("retains saved status when a subsequent refresh fails", async () => {
  const { controller, options } = controllerFixture();
  options.refreshRuntimeConfig.mockRejectedValue(new Error("offline"));
  await expect(controller.remove(selected)).resolves.toBe(true);
  expect(options.onSaved).toHaveBeenCalledOnce();
  expect(options.setStatus).toHaveBeenCalledWith(
    "Model removed; refresh required: offline",
    "error-text",
  );
  expect(options.removeModel).toHaveBeenCalledOnce();
});

test("a rejected removal leaves activation unchanged and displays the reason", async () => {
  const { controller, options } = controllerFixture();
  options.removeModel.mockRejectedValue(
    Object.assign(new Error("Change the default model first."), {
      status: 409,
      payload: { error: "model_removal_invalid_config" },
    }),
  );
  await expect(controller.remove(selected)).resolves.toBe(false);
  expect(options.setStatus).toHaveBeenCalledWith(
    "Change the default model first.",
    "error-text",
  );
  expect(options.onSaved).not.toHaveBeenCalled();
  expect(options.refreshRuntimeConfig).not.toHaveBeenCalled();
  expect(options.loadDashboard).not.toHaveBeenCalled();
});

test.each([
  new TypeError("Failed to fetch"),
  Object.assign(new Error("HTTP 500"), {
    status: 500,
    payload: { error: "model_setup_failed" },
  }),
])(
  "an uncertain DELETE response confirms a committed removal: %s",
  async (error) => {
    const { controller, options } = controllerFixture();
    options.removeModel.mockRejectedValue(error);
    options.loadDashboard.mockResolvedValue(registrationDashboard([]));
    await expect(controller.remove(selected)).resolves.toBe(true);
    expect(options.loadDashboard).toHaveBeenCalledExactlyOnceWith("prod");
    expect(options.onSaved).toHaveBeenCalledOnce();
    expect(options.refreshRuntimeConfig).toHaveBeenCalledOnce();
    expect(options.removeModel).toHaveBeenCalledOnce();
  },
);

test("an uncertain DELETE checks the original environment after a selection change", async () => {
  const { controller, options } = controllerFixture();
  options.removeModel.mockImplementation(async () => {
    options.getEnvironmentId.mockReturnValue("dev");
    throw new TypeError("Failed to fetch");
  });
  options.loadDashboard.mockResolvedValue(registrationDashboard([]));
  await expect(controller.remove(selected)).resolves.toBe(true);
  expect(options.removeModel).toHaveBeenCalledWith(
    { profileId: "declared", expectedRevision: "root-revision" },
    "prod",
  );
  expect(options.loadDashboard).toHaveBeenCalledExactlyOnceWith("prod");
  expect(options.refreshRuntimeConfig).not.toHaveBeenCalled();
  expect(options.onSaved).not.toHaveBeenCalled();
  expect(options.setStatus).toHaveBeenCalledWith(
    expect.stringContaining("previous environment"),
  );
});

test("an uncertain DELETE leaves activation alone when the declaration remains", async () => {
  const { controller, options } = controllerFixture();
  options.removeModel.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(controller.remove(selected)).resolves.toBe(false);
  expect(options.onSaved).not.toHaveBeenCalled();
  expect(options.refreshRuntimeConfig).not.toHaveBeenCalled();
  expect(options.setStatus).toHaveBeenCalledWith(
    "Failed to fetch",
    "error-text",
  );
});

test("an unavailable reconciliation reports an unconfirmed outcome", async () => {
  const { controller, options } = controllerFixture();
  options.removeModel.mockRejectedValue(new TypeError("Failed to fetch"));
  options.loadDashboard.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(controller.remove(selected)).resolves.toBe(false);
  expect(options.onSaved).not.toHaveBeenCalled();
  expect(options.refreshRuntimeConfig).not.toHaveBeenCalled();
  expect(options.setStatus).toHaveBeenCalledWith(
    expect.stringContaining("could not be confirmed"),
    "error-text",
  );
});

test("suppresses duplicate clicks while removal is pending", async () => {
  const { controller, options } = controllerFixture();
  let finish!: (result: { restartRequired: boolean }) => void;
  options.removeModel.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = controller.remove(selected);
  await expect(controller.remove(selected)).resolves.toBe(false);
  finish({ restartRequired: true });
  await first;
  expect(options.removeModel).toHaveBeenCalledOnce();
});
