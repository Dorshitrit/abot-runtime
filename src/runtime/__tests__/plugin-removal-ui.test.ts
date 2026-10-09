import { expect, test, vi } from "vitest";
// @ts-expect-error Browser module.
import { createPluginRemoval } from "../../web-ui/app/components/plugins/removal.js";
// @ts-expect-error Browser module.
import { renderPluginManager } from "../../web-ui/app/components/plugins/rendering.js";

function harness(overrides = {}) {
  let environment = "dev";
  const dependencies = {
    removePlugin: vi.fn(async () => ({
      removed: true,
      plugins: [],
      message: "example removed.",
      activation: { status: "ready" },
    })),
    confirmRemoval: vi.fn(() => true),
    getEnvironmentId: () => environment,
    beginRuntimeMutation: vi.fn(() => true),
    endRuntimeMutation: vi.fn(),
    refreshRuntimeConfig: vi.fn(async () => true),
    onConfigurationSaved: vi.fn(),
    onConfigurationApplied: vi.fn(async () => {}),
    onConfigurationSettled: vi.fn(() => true),
    onSnapshot: vi.fn(),
    render: vi.fn(),
    ...overrides,
  };
  return {
    dependencies,
    controller: createPluginRemoval(dependencies),
    setEnvironment: (value: string) => {
      environment = value;
    },
  };
}

test("Remove confirms once, applies and refreshes, with a quiet result", async () => {
  const { dependencies: d, controller } = harness();
  expect(await controller.remove("example")).toBe(true);
  expect(d.removePlugin).toHaveBeenCalledWith({ pluginId: "example" }, "dev");
  expect(d.confirmRemoval).toHaveBeenCalledOnce();
  expect(d.onConfigurationApplied).toHaveBeenCalledOnce();
  expect(d.onConfigurationSaved).not.toHaveBeenCalled();
  expect(d.endRuntimeMutation).toHaveBeenCalledOnce();
  expect(d.onConfigurationSettled).toHaveBeenCalledOnce();
  expect(d.endRuntimeMutation.mock.invocationCallOrder[0]).toBeLessThan(
    d.onConfigurationSettled.mock.invocationCallOrder[0],
  );
  expect(controller.state).toMatchObject({
    busy: false,
    message: "example removed.",
    error: "",
  });
});

test.each([
  { confirmRemoval: () => false },
  { beginRuntimeMutation: () => false },
])("cancel or unsaved edits prevent removal", async (overrides) => {
  const { dependencies, controller } = harness(overrides);
  expect(await controller.remove("example")).toBe(false);
  expect(dependencies.removePlugin).not.toHaveBeenCalled();
});

test("busy owners keep pending feedback without claiming removal", async () => {
  const { controller, dependencies: d } = harness({
    removePlugin: async () => ({
      removed: false,
      message: "Try Remove again when idle.",
      activation: { status: "restart_required" },
    }),
  });
  expect(await controller.remove("example")).toBe(false);
  expect(controller.state.message).toContain("again");
  expect(d.onConfigurationApplied).not.toHaveBeenCalled();
  expect(d.onConfigurationSaved).toHaveBeenCalledOnce();
});

test("late completion from another environment cannot replace the current view", async () => {
  let complete!: (result: unknown) => void;
  const {
    controller,
    dependencies: d,
    setEnvironment,
  } = harness({
    removePlugin: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const pending = controller.remove("example");
  setEnvironment("production");
  controller.resetEnvironment();
  complete({
    removed: true,
    message: "example removed.",
    activation: { status: "ready" },
  });
  expect(await pending).toBe(false);
  expect(d.onSnapshot).not.toHaveBeenCalled();
  expect(controller.state.message).toBe("");
});

test("Remove is exposed only for external installations in the ongoing manager", () => {
  const snapshot = {
    plugins: [
      { id: "external", removable: true },
      { id: "built-in", removable: false },
    ],
  };
  const html = renderPluginManager({ snapshot, canRemove: true });
  expect(html).toContain('data-plugin-remove="external"');
  expect(html).not.toContain('data-plugin-remove="built-in"');
  expect(renderPluginManager({ snapshot })).not.toContain(
    "data-plugin-remove=",
  );
});

test.each([
  "plugin_not_removable",
  "plugin_mutation_unavailable",
  "plugin_runtime_busy",
  "plugin_owner_unavailable",
  "configuration_request_rejected",
])(
  "a definitive %s rejection does not invent pending changes",
  async (code) => {
    const { controller, dependencies: d } = harness({
      removePlugin: async () => {
        throw Object.assign(new Error("rejected"), { status: 409, code });
      },
    });
    expect(await controller.remove("example")).toBe(false);
    expect(controller.state.error).toBe("rejected");
    expect(d.onConfigurationSaved).not.toHaveBeenCalled();
    expect(d.refreshRuntimeConfig).not.toHaveBeenCalled();
    expect(d.onConfigurationSettled).not.toHaveBeenCalled();
  },
);

test.each([
  "config_changed",
  "plugin_changed",
  "plugin_still_active",
  undefined,
])(
  "an uncertain or post-save %s failure keeps safe pending feedback",
  async (code) => {
    const { controller, dependencies: d } = harness({
      removePlugin: async () => {
        throw Object.assign(new Error("incomplete"), { status: 409, code });
      },
    });
    expect(await controller.remove("example")).toBe(false);
    expect(d.onConfigurationSaved).toHaveBeenCalledOnce();
    expect(d.refreshRuntimeConfig).toHaveBeenCalledOnce();
    expect(d.onConfigurationSettled).not.toHaveBeenCalled();
  },
);

test.each(["projection", "refresh"])(
  "settles applied environments after unlock even if %s fails",
  async (phase) => {
    const { controller, dependencies: d } = harness({
      ...(phase === "projection"
        ? {
            onConfigurationApplied: vi.fn(async () => {
              throw new Error("load failed");
            }),
          }
        : {
            refreshRuntimeConfig: vi.fn(async () => {
              throw new Error("refresh failed");
            }),
          }),
    });
    expect(await controller.remove("example")).toBe(false);
    expect(d.onConfigurationSettled).toHaveBeenCalledOnce();
    expect(d.endRuntimeMutation.mock.invocationCallOrder[0]).toBeLessThan(
      d.onConfigurationSettled.mock.invocationCallOrder[0],
    );
    expect(d.onConfigurationSaved).not.toHaveBeenCalled();
  },
);

function readyFailure(code = "plugin_changed") {
  return Object.assign(new Error("Removal incomplete."), {
    status: 409,
    code,
    payload: { activation: { status: "ready" } },
  });
}

test.each(["plugin_changed", "config_changed"])(
  "%s after Apply updates active state and settles after unlock",
  async (code) => {
    const { controller, dependencies: d } = harness({
      removePlugin: async () => {
        throw readyFailure(code);
      },
    });
    expect(await controller.remove("example")).toBe(false);
    expect(d.onConfigurationApplied).toHaveBeenCalledOnce();
    expect(d.onConfigurationSaved).toHaveBeenCalledTimes(
      code === "config_changed" ? 1 : 0,
    );
    if (code === "config_changed")
      expect(d.onConfigurationApplied.mock.invocationCallOrder[0]).toBeLessThan(
        d.onConfigurationSaved.mock.invocationCallOrder[0],
      );
    expect(d.onConfigurationSettled).toHaveBeenCalledOnce();
    expect(d.endRuntimeMutation.mock.invocationCallOrder[0]).toBeLessThan(
      d.onConfigurationSettled.mock.invocationCallOrder[0],
    );
    expect(d.onSnapshot).not.toHaveBeenCalled();
    expect(controller.state).toMatchObject({
      busy: false,
      message: "",
      error: "Removal incomplete.",
    });
  },
);

test.each(["projection", "refresh", "settlement"])(
  "post-Apply error preserves its cause when %s fails",
  async (phase) => {
    const d = harness({
      removePlugin: async () => {
        throw readyFailure("config_changed");
      },
      ...(phase === "projection"
        ? {
            onConfigurationApplied: vi.fn(async () => {
              throw new Error("projection failed");
            }),
          }
        : {}),
      ...(phase === "refresh"
        ? {
            refreshRuntimeConfig: vi.fn(async () => {
              throw new Error("refresh failed");
            }),
          }
        : {}),
      ...(phase === "settlement"
        ? {
            onConfigurationSettled: vi.fn(() => {
              throw new Error("settlement failed");
            }),
          }
        : {}),
    });
    expect(await d.controller.remove("example")).toBe(false);
    expect(d.dependencies.onConfigurationSaved).toHaveBeenCalledOnce();
    expect(d.dependencies.onConfigurationSettled).toHaveBeenCalledOnce();
    expect(d.controller.state.error).toContain("Removal incomplete.");
    expect(d.controller.state.error).toContain("Refresh configuration");
    expect(d.controller.state.error).not.toContain("Plugin removed");
  },
);

test("a late ready failure cannot update another environment", async () => {
  let reject!: (error: unknown) => void;
  const h = harness({
    removePlugin: () =>
      new Promise((_, no) => {
        reject = no;
      }),
  });
  const pending = h.controller.remove("example");
  h.setEnvironment("prod");
  h.controller.resetEnvironment();
  reject(readyFailure());
  expect(await pending).toBe(false);
  expect(h.dependencies.onConfigurationApplied).not.toHaveBeenCalled();
  expect(h.dependencies.onConfigurationSettled).not.toHaveBeenCalled();
  expect(h.controller.state.error).toBe("");
});

test("environment change during failed-removal projection fences later UI updates", async () => {
  let finish!: () => void;
  const h = harness({
    removePlugin: async () => {
      throw readyFailure("config_changed");
    },
    onConfigurationApplied: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  });
  const pending = h.controller.remove("example");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  h.setEnvironment("prod");
  h.controller.resetEnvironment();
  finish();
  expect(await pending).toBe(false);
  expect(h.dependencies.onConfigurationSaved).not.toHaveBeenCalled();
  expect(h.dependencies.refreshRuntimeConfig).not.toHaveBeenCalled();
  expect(h.dependencies.onConfigurationSettled).not.toHaveBeenCalled();
  expect(h.controller.state.error).toBe("");
});
