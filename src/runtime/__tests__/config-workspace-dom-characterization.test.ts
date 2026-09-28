import { describe, expect, test, vi } from "vitest";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigWorkspace } from "../../web-ui/app/components/config-workspace.js";

type Listener = (event: Record<string, unknown>) => void;
type TestElement = Record<string, any>;

const CONFIG_SECTIONS = ["models", "plugins", "operations"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createElement(dataset: Record<string, string> = {}) {
  const attributes = new Map<string, string>();
  return {
    classList: {
      toggle() {},
    },
    dataset,
    focus: vi.fn(),
    hidden: false,
    tabIndex: 0,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  } as TestElement;
}

function createEventTarget(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Listener[]>();
  const target: TestElement = {
    ...extra,
    addEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    }),
    dispatch(type: string, input: Record<string, unknown> = {}) {
      const event = { target, ...input };
      for (const listener of listeners.get(type) || []) listener(event);
      return event;
    },
    listenerCount: (type: string) => listeners.get(type)?.length || 0,
  };
  return target;
}

function createRawEditor() {
  const editor = createElement();
  let value = "";
  editor.id = "configRawEditor";
  editor.valueWrites = 0;
  editor.closest = () => null;
  Object.defineProperty(editor, "value", {
    get: () => value,
    set: (nextValue: string) => {
      editor.valueWrites += 1;
      value = nextValue;
    },
  });
  return editor;
}

function createDashboardElement() {
  const dashboard = Object.assign(createEventTarget(), createElement());
  let html = "";
  let categoryPanels: TestElement[] = [];
  let rawEditor: TestElement | null = null;
  let mountRoots = { management: {}, setup: {} };

  function rebuildRenderedNodes() {
    categoryPanels = [];
    for (const category of CONFIG_SECTIONS) {
      const capitalized = `${category[0].toUpperCase()}${category.slice(1)}`;
      const start = html.indexOf(`id="config${capitalized}Panel"`);
      if (start < 0) continue;
      const opening = html.slice(
        html.lastIndexOf("<section", start),
        html.indexOf(">", start),
      );
      const panel = createElement({ configCategoryPanel: category });
      panel.hidden = /\bhidden\b/u.test(opening);
      categoryPanels.push(panel);
    }
    rawEditor = html.includes('id="configRawEditor"')
      ? createRawEditor()
      : null;
    mountRoots = { management: {}, setup: {} };
  }

  Object.defineProperty(dashboard, "innerHTML", {
    get: () => html,
    set: (value: string) => {
      html = value;
      rebuildRenderedNodes();
    },
  });
  Object.assign(dashboard, {
    panel: (category: string) =>
      categoryPanels.find(
        (panel) => panel.dataset.configCategoryPanel === category,
      ),
    currentRawEditor: () => rawEditor,
    mountRoot: (kind: "management" | "setup") => mountRoots[kind],
    querySelector(selector: string) {
      if (selector === "[data-long-term-memory-setup]") return mountRoots.setup;
      if (selector === "[data-long-term-memory-management]")
        return mountRoots.management;
      if (selector === "#configRawEditor") return rawEditor;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "[data-config-category-panel]") return categoryPanels;
      return [];
    },
  });
  return dashboard;
}

function configFile(
  kind: "runtime" | "requestRunner" | "model",
  id: string,
  path: string,
  config: Record<string, unknown>,
) {
  return {
    config: structuredClone(config),
    exists: true,
    id,
    kind,
    path,
  };
}

function modelFile(id: string, label: string) {
  return configFile("model", id, `models/${id}.config.json`, {
    label,
    model: `${id}-model`,
    provider: "ollama",
  });
}

function dashboardPayload(
  models = [modelFile("alpha", "Alpha Model"), modelFile("beta", "Beta Model")],
) {
  return {
    dashboard: {
      files: {
        models,
        requestRunner: configFile(
          "requestRunner",
          "requestRunner",
          "request-runner.config.json",
          { models: { defaults: { steps: { draft: "careful" } } } },
        ),
        runtime: configFile("runtime", "runtime", "runtime.config.json", {}),
      },
      modelSteps: ["draft", "review"],
    },
  };
}

function actionTarget(
  action: string,
  dataset: Record<string, string> = {},
  row: TestElement | null = null,
) {
  const target: TestElement = {
    dataset: { configAction: action, ...dataset },
    closest(selector: string) {
      if (selector === "[data-config-action]") return target;
      return selector === ".config-add-row" ? row : null;
    },
    matches: () => false,
  };
  return target;
}

function addStepTarget() {
  const row = {
    querySelector(selector: string) {
      if (selector === "[data-new-step-key]") return { value: "review" };
      if (selector === "[data-new-step-value]") return { value: "careful" };
      return null;
    },
  };
  return actionTarget(
    "add-step",
    {
      id: "requestRunner",
      kind: "requestRunner",
      path: JSON.stringify(["models", "defaults", "steps"]),
    },
    row,
  );
}

function createHarness(options: Record<string, any> = {}) {
  const configDashboard = createDashboardElement();
  const configStatus = createEventTarget({ className: "", textContent: "" });
  const refreshConfigButton = createEventTarget({ disabled: false });
  const eventTarget = createEventTarget({ document: { activeElement: null } });
  const loadDashboard =
    options.loadDashboard || vi.fn(async () => dashboardPayload());
  const memorySetup = options.memorySetup || {
    load: vi.fn(async () => {}),
    mount: vi.fn(),
  };
  const memoryManagement = options.memoryManagement || {
    load: vi.fn(async () => {}),
    mount: vi.fn(),
  };
  const recordControlEvent = vi.fn();
  const confirmDiscard = options.confirmDiscard || vi.fn(() => true);
  const workspace = createConfigWorkspace({
    confirmDiscard,
    dom: { configDashboard, configStatus, refreshConfigButton },
    eventTarget,
    loadDashboard,
    memoryManagement,
    memorySetup,
    recordControlEvent,
    saveFile: options.saveFile || vi.fn(async () => ({ ok: true })),
  });
  return {
    configDashboard,
    configStatus,
    confirmDiscard,
    eventTarget,
    loadDashboard,
    memoryManagement,
    memorySetup,
    recordControlEvent,
    refreshConfigButton,
    workspace,
  };
}

describe("config workspace DOM characterization", () => {
  test("renders labeled workspace regions and switches their visibility through the shared owner", async () => {
    const harness = createHarness();
    harness.workspace.bind();
    await harness.workspace.load();

    const html = harness.configDashboard.innerHTML as string;
    const labels = {
      models: "Models",
      plugins: "Plugins",
      operations: "System",
    };
    const positions = CONFIG_SECTIONS.map((category) => {
      const name = `${category[0].toUpperCase()}${category.slice(1)}`;
      expect(html).toContain(`id="config${name}Panel"`);
      expect(html).toContain(
        `aria-label="${labels[category as keyof typeof labels]}"`,
      );
      expect(html).toContain(`data-config-category-panel="${category}"`);
      return html.indexOf(`id="config${name}Panel"`);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('role="region"');
    for (const role of ["tablist", "tab", "tabpanel"])
      expect(html).not.toContain(`role="${role}"`);
    for (const action of [
      "add-calibration",
      "field",
      "reset-file",
      "save-file",
      "select-model",
    ])
      expect(html).toContain(`data-config-action="${action}"`);
    expect(html).not.toContain('data-config-action="select-category"');
    expect(html).not.toContain('data-config-action="delete-path"');
    for (const retired of ["computer", "memory", "pipeline", "advanced"])
      expect(html).not.toContain(`data-config-category-panel="${retired}"`);
    expect(html).not.toContain('id="configRawEditor"');
    expect(harness.memorySetup.mount).not.toHaveBeenCalled();
    expect(harness.memoryManagement.mount).not.toHaveBeenCalled();

    harness.workspace.setWorkspace("models");
    harness.configDashboard.dispatch("click", {
      target: actionTarget("select-model", { modelId: "beta" }),
    });
    expect(harness.configDashboard.innerHTML).toContain("<h3>Beta Model</h3>");
    expect(harness.configDashboard.panel("models").hidden).toBe(false);

    harness.workspace.setWorkspace("plugins");
    expect(harness.workspace.activeCategory()).toBe("plugins");
    expect(harness.configDashboard.panel("plugins").hidden).toBe(false);
    expect(harness.configDashboard.panel("models").hidden).toBe(true);
    harness.workspace.setWorkspace("config");
    expect(harness.workspace.activeCategory()).toBe("operations");
    expect(harness.configDashboard.panel("operations").hidden).toBe(false);
    expect(harness.configDashboard.panel("plugins").hidden).toBe(true);
    harness.workspace.setWorkspace("models");
    expect(harness.configDashboard.innerHTML).toContain("<h3>Beta Model</h3>");
    expect(harness.configDashboard.panel("models").hidden).toBe(false);
  });

  test("keeps linked JSON repair available without restoring the Advanced tab", async () => {
    const payload = dashboardPayload();
    Object.assign(payload.dashboard.files.requestRunner, {
      invalidJson: { raw: '{"broken":', message: "Invalid JSON" },
    });
    const harness = createHarness({
      loadDashboard: vi.fn(async () => payload),
    });
    await harness.workspace.load();
    expect(harness.workspace.activeCategory()).toBe("models");
    expect(harness.configDashboard.innerHTML).toContain(
      'aria-label="Repair configuration file"',
    );
    expect(harness.configDashboard.innerHTML).toContain('id="configRawEditor"');
    expect(harness.configDashboard.innerHTML).not.toContain(
      'data-config-category="advanced"',
    );
  });

  test("preserves runner mapping mutations without showing the retired Pipeline tab", async () => {
    const harness = createHarness();
    harness.workspace.bind();
    await harness.workspace.load();

    harness.configDashboard.dispatch("click", { target: addStepTarget() });
    expect(harness.workspace.hasUnsavedChanges()).toBe(true);
    expect(harness.configDashboard.innerHTML).not.toContain(
      'data-config-category="pipeline"',
    );
    harness.configDashboard.dispatch("click", {
      target: actionTarget("delete-path", {
        id: "requestRunner",
        kind: "requestRunner",
        path: JSON.stringify(["models", "defaults", "steps", "review"]),
      }),
    });
    expect(harness.workspace.hasUnsavedChanges()).toBe(false);

    harness.configDashboard.dispatch("click", { target: addStepTarget() });
    harness.configDashboard.dispatch("click", {
      target: actionTarget("reset-file", {
        id: "requestRunner",
        kind: "requestRunner",
      }),
    });
    expect(harness.workspace.hasUnsavedChanges()).toBe(false);
  });

  test("binds once and protects refresh when visible model settings change", async () => {
    const confirmDiscard = vi.fn(() => false);
    const harness = createHarness({ confirmDiscard });
    harness.workspace.bind();
    harness.workspace.bind();
    await harness.workspace.load();
    expect(harness.eventTarget.listenerCount("beforeunload")).toBe(1);
    expect(harness.configDashboard.listenerCount("click")).toBe(1);
    expect(harness.refreshConfigButton.listenerCount("click")).toBe(1);

    const field = actionTarget("field", {
      id: "runtime",
      kind: "runtime",
      path: JSON.stringify(["marker"]),
      valueType: "string",
    });
    field.value = "changed";
    harness.configDashboard.dispatch("input", { target: field });
    expect(harness.workspace.hasUnsavedChanges()).toBe(true);

    const preventDefault = vi.fn();
    const beforeUnload = harness.eventTarget.dispatch("beforeunload", {
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(beforeUnload.returnValue).toBe("");
    harness.refreshConfigButton.dispatch("click");
    expect(confirmDiscard).toHaveBeenCalledOnce();
    expect(harness.loadDashboard).toHaveBeenCalledOnce();
  });

  test("keeps discard blocked while a canonical refresh is loading", async () => {
    const canonicalRefresh = deferred<ReturnType<typeof dashboardPayload>>();
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(dashboardPayload())
      .mockImplementationOnce(() => canonicalRefresh.promise);
    const harness = createHarness({ loadDashboard });
    harness.workspace.bind();
    await harness.workspace.load();

    const field = actionTarget("field", {
      id: "runtime",
      kind: "runtime",
      path: JSON.stringify(["models", "profiles", "added"]),
      valueType: "string",
    });
    field.value = "added-profile";
    harness.configDashboard.dispatch("input", { target: field });
    harness.configDashboard.dispatch("click", {
      target: actionTarget("save-file", { id: "runtime", kind: "runtime" }),
    });

    await vi.waitFor(() => expect(loadDashboard).toHaveBeenCalledTimes(2));
    expect(
      harness.workspace.prepareDiscardChanges("change environment"),
    ).toBeNull();
    expect(harness.configStatus.textContent).toContain(
      "Wait for the current save",
    );

    canonicalRefresh.resolve(dashboardPayload());
    await vi.waitFor(() =>
      expect(harness.configDashboard.getAttribute("aria-busy")).toBe("false"),
    );
  });

  test("ignores stale memory completion after a newer dashboard wins", async () => {
    const oldSetup = deferred<void>();
    const oldManagement = deferred<void>();
    const memorySetup = {
      load: vi
        .fn()
        .mockImplementationOnce(() => oldSetup.promise)
        .mockResolvedValue(undefined),
      mount: vi.fn(),
    };
    const memoryManagement = {
      load: vi
        .fn()
        .mockImplementationOnce(() => oldManagement.promise)
        .mockResolvedValue(undefined),
      mount: vi.fn(),
    };
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(dashboardPayload([modelFile("old", "Old Model")]))
      .mockResolvedValueOnce(dashboardPayload([modelFile("new", "New Model")]));
    const harness = createHarness({
      loadDashboard,
      memoryManagement,
      memorySetup,
    });

    const oldLoad = harness.workspace.load();
    await vi.waitFor(() => expect(memorySetup.load).toHaveBeenCalledOnce());
    const newLoad = harness.workspace.load();
    await expect(newLoad).resolves.toBe(true);
    oldSetup.resolve();
    oldManagement.resolve();

    await expect(oldLoad).resolves.toBe(false);
    expect(harness.configDashboard.innerHTML).toContain("New Model");
    expect(harness.configDashboard.innerHTML).not.toContain("Old Model");
  });
});
