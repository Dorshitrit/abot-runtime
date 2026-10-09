import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigWorkspace } from "../../web-ui/app/components/config-workspace.js";
// prettier-ignore
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderModelPluginPermissions } from "../../web-ui/app/components/config-workspace/model-plugin-permissions.js";

function element() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  return {
    innerHTML: "",
    textContent: "",
    className: "",
    inert: false,
    disabled: false,
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    dispatch(type: string, target: unknown) {
      for (const listener of listeners.get(type) || []) listener({ target });
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute: vi.fn(),
  };
}

function action(actionName: string, id: string, fields = {}) {
  const target = {
    dataset: { configAction: actionName, kind: "model", id, ...fields },
    checked: false,
    closest: () => target,
    matches: () => false,
  };
  return target;
}

function model(id: string, config: Record<string, unknown> = {}) {
  return {
    kind: "model",
    id,
    label: id,
    exists: true,
    path: `local/models/${id}.config.json`,
    revision: `${id}-revision`,
    config: { label: id, provider: "ollama", model: id, ...config },
  };
}

function dashboard(models = [model("alpha"), model("beta")]) {
  return {
    dashboard: {
      files: {
        models,
        runtime: {
          kind: "runtime",
          id: "runtime",
          path: "local/runtime.config.json",
          config: { plugins: { deny: ["globally-blocked"] } },
        },
      },
    },
  };
}

const catalog = {
  plugins: [
    {
      id: "filesystem",
      description: "File tools",
      state: "partial",
      pluginEnabled: true,
      capabilities: [
        { id: "read_file", description: "Read files", enabled: false },
        { id: "write_file", description: "Write files", enabled: true },
        { id: "list_directory", description: "List files", enabled: true },
      ],
    },
    {
      id: "memory",
      description: "Saved notes",
      state: "disabled",
      pluginEnabled: false,
      capabilities: [{ id: "memory", description: "Remember", enabled: false }],
    },
    {
      id: "web",
      description: "Browse pages",
      state: "enabled",
      pluginEnabled: true,
      capabilities: [{ id: "browse", description: "Browse", enabled: true }],
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function harness(
  options: {
    loadDashboard?: () => Promise<ReturnType<typeof dashboard>>;
    loadModelPlugins?: () => Promise<typeof catalog>;
  } = {},
) {
  const configDashboard = element();
  const saveFile = vi.fn(async (_input: Record<string, unknown>) => ({
    file: { revision: "saved-revision" },
  }));
  const workspace = createConfigWorkspace({
    dom: {
      configDashboard,
      refreshConfigButton: element(),
      configStatus: element(),
    },
    loadDashboard: options.loadDashboard || (async () => dashboard()),
    loadModelPlugins: options.loadModelPlugins || (async () => catalog),
    saveFile,
    memorySetup: { load: async () => {} },
    memoryManagement: { load: async () => {} },
    recordControlEvent: vi.fn(),
    confirmDiscard: vi.fn(() => true),
    eventTarget: {
      addEventListener: vi.fn(),
      document: { activeElement: null },
    },
  });
  workspace.bind();
  return { configDashboard, saveFile, workspace };
}

describe("model plugin restrictions", () => {
  test("starts collapsed and exposes granular switches with read-only broad rules", () => {
    const html = renderModelPluginPermissions(
      model("alpha", {
        plugins: { deny: ["*", "memory", "filesystem.read_file"] },
      }),
      { ...catalog, error: "" },
    );
    expect(html).toContain('data-model-plugin-section="alpha"');
    expect(html).toContain('data-model-plugin-details="filesystem"');
    expect(html).toContain('data-capability-id="write_file"');
    expect(html).toContain('data-model-plugin-retained="alpha"');
    expect(html).not.toMatch(/<details[^>]+\sopen[\s>]/u);
    expect(html).not.toContain('class="config-field-grid"');
  });

  test("does not expose selection controls for malformed saved rules", () => {
    const config = { plugins: { deny: "memory" } };
    expect(
      renderModelPluginPermissions(model("alpha", config), catalog),
    ).not.toContain('type="checkbox"');
    expect(config).toEqual({ plugins: { deny: "memory" } });
  });

  test("escapes catalog and retained selector text", () => {
    const html = renderModelPluginPermissions(
      model("<model>", { plugins: { deny: ["<unknown>"] } }),
      { plugins: [{ id: '<plugin>"', description: "<script>" }] },
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<unknown>");
    expect(html).toContain("&lt;unknown&gt;");
  });

  test("saves and reloads only the selected model using its existing revision path", async () => {
    const payload = dashboard([
      model("alpha", {
        plugins: { deny: ["filesystem.read_file", "missing-plugin"] },
      }),
      model("beta"),
    ]);
    const loadDashboard = vi.fn(async () => structuredClone(payload));
    const { workspace, configDashboard, saveFile } = harness({ loadDashboard });
    await workspace.load();
    const toggle = action("model-plugin-capability-enabled", "alpha", {
      pluginId: "filesystem",
      capabilityId: "write_file",
    });
    toggle.checked = false;
    configDashboard.dispatch("change", toggle);
    expect(workspace.hasUnsavedChanges()).toBe(true);
    configDashboard.dispatch("click", action("reset-file", "alpha"));
    expect(workspace.hasUnsavedChanges()).toBe(false);
    configDashboard.dispatch("change", toggle);
    configDashboard.dispatch("click", action("save-file", "alpha"));
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile).toHaveBeenCalledWith({
      kind: "model",
      id: "alpha",
      expectedRevision: "alpha-revision",
      config: {
        label: "alpha",
        provider: "ollama",
        model: "alpha",
        plugins: {
          deny: [
            "filesystem.read_file",
            "missing-plugin",
            "filesystem.write_file",
          ],
        },
      },
    });
    await vi.waitFor(() => expect(workspace.hasUnsavedChanges()).toBe(false));
    workspace.selectModel("beta");
    expect(configDashboard.innerHTML).toMatch(
      /<input(?=[^>]*data-capability-id="write_file")(?=[^>]*checked)[^>]*>/u,
    );
    expect(payload.dashboard.files.runtime.config.plugins.deny).toEqual([
      "globally-blocked",
    ]);
    payload.dashboard.files.models[0]!.config = saveFile.mock.calls[0]![0]
      .config as (typeof payload.dashboard.files.models)[number]["config"];
    await workspace.load();
    workspace.selectModel("alpha");
    expect(configDashboard.innerHTML).not.toMatch(
      /<input(?=[^>]*data-capability-id="write_file")(?=[^>]*checked)[^>]*>/u,
    );
  });

  test("catalog failure retains saved rules and leaves model editing available", async () => {
    const payload = dashboard([
      model("alpha", { plugins: { deny: ["memory"] } }),
    ]);
    const { workspace, configDashboard } = harness({
      loadDashboard: async () => payload,
      loadModelPlugins: async () => {
        throw new Error("catalog offline");
      },
    });
    expect(await workspace.load()).toBe(true);
    expect(configDashboard.innerHTML).toContain("Plugin list unavailable");
    expect(configDashboard.innerHTML).toContain("memory");
    expect(configDashboard.innerHTML).not.toContain(
      'data-config-action="model-plugin-enabled"',
    );
    expect(configDashboard.inert).toBe(false);
    expect(payload.dashboard.files.models[0]!.config).toMatchObject({
      plugins: { deny: ["memory"] },
    });
  });

  test("ignores stale catalog responses and blocks editing during a new environment load", async () => {
    const pending = deferred<typeof catalog>();
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(dashboard([model("alpha")]))
      .mockResolvedValueOnce(dashboard([model("old-environment")]))
      .mockResolvedValueOnce(dashboard([model("new-environment")]));
    const loadModelPlugins = vi
      .fn()
      .mockResolvedValueOnce(catalog)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        plugins: [{ id: "new-plugin", state: "enabled" }],
      });
    const { workspace, configDashboard } = harness({
      loadDashboard,
      loadModelPlugins,
    });
    await workspace.load();
    const oldLoad = workspace.load();
    expect(configDashboard.setAttribute).toHaveBeenLastCalledWith(
      "aria-busy",
      "true",
    );
    const toggle = action("model-plugin-capability-enabled", "alpha", {
      pluginId: "filesystem",
      capabilityId: "write_file",
    });
    toggle.checked = false;
    configDashboard.dispatch("change", toggle);
    expect(workspace.hasUnsavedChanges()).toBe(false);
    await workspace.load();
    pending.resolve(catalog);
    expect(await oldLoad).toBe(false);
    expect(configDashboard.innerHTML).toContain('data-plugin-id="new-plugin"');
    expect(configDashboard.innerHTML).not.toContain('data-plugin-id="memory"');
    expect(configDashboard.innerHTML).toContain("new-environment");
    expect(configDashboard.inert).toBe(false);
  });
});
