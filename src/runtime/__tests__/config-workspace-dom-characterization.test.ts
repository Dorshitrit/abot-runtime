import { describe, expect, test, vi } from "vitest";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigWorkspace } from "../../web-ui/app/components/config-workspace.js";

type Listener = (event: Record<string, unknown>) => void;
type TestElement = Record<string, any>;

const CONFIG_CATEGORIES = ["memory", "pipeline", "models", "advanced"];

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
  let categoryButtons = new Map<string, TestElement>();
  let categoryPanels: TestElement[] = [];
  let rawEditor: TestElement | null = null;
  let mountRoots = { management: {}, setup: {} };

  function rebuildRenderedNodes() {
    categoryButtons = new Map();
    categoryPanels = [];
    for (const category of CONFIG_CATEGORIES) {
      const capitalized = `${category[0].toUpperCase()}${category.slice(1)}`;
      const start = html.indexOf(`id="configCategory${capitalized}"`);
      if (start < 0) continue;
      const tabMarkup = html.slice(start, html.indexOf("</button>", start));
      const active = tabMarkup.includes('aria-selected="true"');
      const button = createElement({
        configAction: "select-category",
        configCategory: category,
      });
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
      button.closest = (selector: string) =>
        selector === "[data-config-action]" ||
        selector === "[data-config-category]"
          ? button
          : null;
      categoryButtons.set(category, button);
      const panel = createElement({ configCategoryPanel: category });
      panel.hidden = !active;
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
    category: (category: string) => categoryButtons.get(category),
    currentRawEditor: () => rawEditor,
    mountRoot: (kind: "management" | "setup") => mountRoots[kind],
    querySelector(selector: string) {
      if (selector === "[data-long-term-memory-setup]") return mountRoots.setup;
      if (selector === "[data-long-term-memory-management]")
        return mountRoots.management;
      if (selector === "#configRawEditor") return rawEditor;
      const categoryMatch = selector.match(
        /^\[data-config-category="([^"]+)"\]$/,
      );
      return categoryMatch ? categoryButtons.get(categoryMatch[1]) : null;
    },
    querySelectorAll(selector: string) {
      if (selector === "[data-config-category]") {
        return [...categoryButtons.values()];
      }
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
  test("preserves category/action/ARIA markup and selection state", async () => {
    const harness = createHarness();
    harness.workspace.bind();
    await harness.workspace.load();

    const html = harness.configDashboard.innerHTML as string;
    const positions = CONFIG_CATEGORIES.map((category) => {
      const name = `${category[0].toUpperCase()}${category.slice(1)}`;
      expect(html).toContain(`id="configCategory${name}"`);
      expect(html).toContain(`aria-controls="config${name}Panel"`);
      expect(html).toContain(`id="config${name}Panel"`);
      expect(html).toContain(`aria-labelledby="configCategory${name}"`);
      expect(html).toContain(`data-config-category="${category}"`);
      expect(html).toContain(`data-config-category-panel="${category}"`);
      return html.indexOf(`id="configCategory${name}"`);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('role="tabpanel"');
    for (const action of [
      "add-calibration",
      "add-step",
      "apply-raw",
      "field",
      "reset-file",
      "save-file",
      "save-raw",
      "select-category",
      "select-model",
      "step-value",
    ]) {
      expect(html).toContain(`data-config-action="${action}"`);
    }
    expect(html).not.toContain('data-config-action="delete-path"');
    expect(harness.memorySetup.mount).toHaveBeenCalledWith(
      harness.configDashboard.mountRoot("setup"),
    );
    expect(harness.memoryManagement.mount).toHaveBeenCalledWith(
      harness.configDashboard.mountRoot("management"),
    );

    harness.configDashboard.dispatch("click", {
      target: harness.configDashboard.category("models"),
    });
    harness.configDashboard.dispatch("toggle", {
      target: { dataset: {}, id: "configRawPanel", open: true },
    });
    harness.configDashboard.dispatch("click", {
      target: actionTarget("select-model", { modelId: "beta" }),
    });
    const rerendered = harness.configDashboard.innerHTML as string;
    const rawPanel = rerendered.indexOf('id="configRawPanel"');
    expect(rerendered).toContain("<h3>Beta Model</h3>");
    expect(
      rerendered.slice(rawPanel, rerendered.indexOf(">", rawPanel)),
    ).toContain("open");
    expect(
      harness.configDashboard.category("models").getAttribute("aria-selected"),
    ).toBe("true");

    const preventDefault = vi.fn();
    harness.configDashboard.dispatch("keydown", {
      key: "ArrowRight",
      preventDefault,
      target: harness.configDashboard.category("models"),
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(
      harness.configDashboard
        .category("advanced")
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      harness.configDashboard.category("advanced").focus,
    ).toHaveBeenCalledOnce();
  });

  test("delegates add, delete, reset, and invalid raw actions", async () => {
    const harness = createHarness();
    harness.workspace.bind();
    await harness.workspace.load();

    harness.configDashboard.dispatch("click", { target: addStepTarget() });
    expect(harness.workspace.hasUnsavedChanges()).toBe(true);
    expect(harness.configDashboard.innerHTML).toContain(
      'aria-label="Mapping target for review"',
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

    const editor = harness.configDashboard.currentRawEditor();
    editor.value = "{invalid";
    harness.configDashboard.dispatch("input", { target: editor });
    harness.configDashboard.dispatch("click", {
      target: actionTarget("apply-raw"),
    });
    expect(harness.configStatus.textContent).toMatch(/^Raw JSON:/);
    expect(harness.recordControlEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "Raw config invalid",
        tone: "failed",
      }),
    );
  });

  test("binds once, protects refresh, and preserves the focused raw editor", async () => {
    const confirmDiscard = vi.fn(() => false);
    const harness = createHarness({ confirmDiscard });
    harness.workspace.bind();
    harness.workspace.bind();
    await harness.workspace.load();
    expect(harness.eventTarget.listenerCount("beforeunload")).toBe(1);
    expect(harness.configDashboard.listenerCount("click")).toBe(1);
    expect(harness.refreshConfigButton.listenerCount("click")).toBe(1);

    const editor = harness.configDashboard.currentRawEditor();
    const originalValue = editor.value;
    const originalWrites = editor.valueWrites;
    const field = actionTarget("field", {
      id: "runtime",
      kind: "runtime",
      path: JSON.stringify(["marker"]),
      valueType: "string",
    });
    field.value = "changed";
    harness.configDashboard.dispatch("input", { target: field });
    expect(editor.value).not.toBe(originalValue);
    expect(editor.valueWrites).toBe(originalWrites + 1);

    const focusedValue = editor.value;
    const focusedWrites = editor.valueWrites;
    harness.eventTarget.document.activeElement = editor;
    field.value = "changed again";
    harness.configDashboard.dispatch("input", { target: field });
    expect(editor.value).toBe(focusedValue);
    expect(editor.valueWrites).toBe(focusedWrites);

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
    await vi.waitFor(() => expect(harness.configDashboard.inert).toBe(false));
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
