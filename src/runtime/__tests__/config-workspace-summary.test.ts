import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only presentation module.
import { modelSummary } from "../../web-ui/app/components/config-workspace/model-summary.js";
// @ts-expect-error Browser-only presentation module.
import { createConfigWorkspaceView } from "../../web-ui/app/components/config-workspace/workspace-view.js";
// @ts-expect-error Browser-only presentation module.
import { createConfigWorkspace } from "../../web-ui/app/components/config-workspace.js";
// @ts-expect-error Browser-only presentation module.
import { renderConfigurationSummary, syncConfigurationSummary } from "../../web-ui/app/components/config-workspace/summary-rendering.js";

type Summary = { label: string; items: Array<{label: string; value: string; dirty?: boolean; status?: boolean}> };
function model(id: string, provider: string, registered = true, image = false) {
  return { kind: "model", id, exists: true, registered, path: `${id}.json`,
    config: { label: id, provider, capabilities: { inputModalities: image ? ["text", "image"] : ["text"] } } };
}
function state() {
  return { activeCategory: "models", loading: false, configDashboardError: false,
    selectedConfigModelId: "one", appliedJsonRepairKeys: new Set(),
    configDashboard: { files: { models: [model("one", "ollama", true, true), model("two", "openai"), model("reference", "other", false, true)] } } };
}
function values(summary: Summary) { return summary.items.map((item) => item.value); }
function dashboardDom() {
  const summary = { innerHTML: "", setAttribute: vi.fn() };
  let html = "";
  let writes = 0;
  const root = {
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; writes += 1; summary.innerHTML = value.match(/<dl[^>]*>([\s\S]*?)<\/dl>/)?.[1] ?? ""; },
    querySelector: (selector: string) => selector === "[data-config-summary]" ? summary : null,
    querySelectorAll: () => [], setAttribute: vi.fn(),
  };
  return { summary, root, writes: () => writes, dom: { configDashboard: root, configStatus: { textContent: "", className: "" }, refreshConfigButton: { disabled: false } } };
}

describe("contextual configuration summaries", () => {
  test("model counts exclude reference profiles while unsaved changes stay local to models", () => {
    const s = state();
    const pending = new Set(["runtime"]);
    const changes = (file: {id: string}) => pending.has(file.id);
    expect(values(modelSummary(s, changes))).toEqual(["2", "2", "1", "All saved"]);
    pending.add("reference");
    expect(modelSummary(s, changes).items[3]).toMatchObject({ value: "1 unsaved model", dirty: true, status: true });
    s.configDashboard.files.models[0]!.config.provider = "openai";
    s.configDashboard.files.models[1]!.config.capabilities.inputModalities.push("image");
    expect(values(modelSummary(s, changes))).toEqual(["2", "1", "2", "1 unsaved model"]);
    pending.clear();
    expect(modelSummary(s, changes).items[3].dirty).toBe(false);
  });

  test("unloaded, loading and failed model reads never look like empty successful data", () => {
    const s = state();
    expect(values(modelSummary({ ...s, loading: true }, () => false))).toEqual(Array(4).fill("Loading…"));
    expect(values(modelSummary({ ...s, configDashboardError: true }, () => false))).toEqual(Array(4).fill("Unavailable"));
    expect(values(modelSummary({ ...s, configDashboard: null }, () => false))).toEqual(Array(4).fill("Not loaded"));
    s.configDashboard.files.models = [];
    expect(values(modelSummary(s, () => false))).toEqual(["0", "0", "0", "All saved"]);
  });

  test("navigation and owner updates change only the summary, preserving the editing DOM", () => {
    const s = state();
    const h = dashboardDom();
    let pluginValue = "7";
    let systemTab = "runtime";
    const plugins = { summary: () => ({ label: "Plugins saved configuration", items: [{ label: "Installed", value: pluginValue }] }), mount: vi.fn() };
    const view = createConfigWorkspaceView({ state: s, dom: h.dom, pluginManagement: plugins,
      getOperationsSummary: () => ({ label: systemTab, items: [{ label: systemTab, value: "current" }] }),
      eventTarget: {document: {}}, configFileEntries: () => [], ensureRawSelection: () => {},
      dashboardIsBusy: () => false, hasPendingFileChanges: () => false,
      renderCategoryPanel: (_: string, content: string) => content,
      renderModelList: () => "", renderSelectedModelEditor: () => "", selectedRawConfigFile: () => null,
    });
    view.renderConfigDashboard();
    const writes = h.writes();
    view.activateCategory("plugins");
    expect(h.summary.innerHTML).toContain(">7</dd>");
    pluginValue = "8";
    view.syncDashboardSummary();
    expect(h.summary.innerHTML).toContain(">8</dd>");
    view.activateCategory("operations");
    systemTab = "health";
    view.syncDashboardSummary();
    expect(h.summary.innerHTML).toContain("<dt>health</dt>");
    view.activateCategory("models");
    s.configDashboard.files.models.pop();
    view.syncDirtyPresentation();
    expect(h.summary.innerHTML).toContain("<dt>Registered models</dt>");
    expect(h.summary.innerHTML).not.toContain("<dt>health</dt>");
    expect(h.writes()).toBe(writes);
  });

  test("configuration refresh errors replace stale counts and a later refresh restores them", async () => {
    const h = dashboardDom();
    const loadDashboard = vi.fn(async () => ({ dashboard: state().configDashboard }));
    const workspace = createConfigWorkspace({ dom: h.dom, loadDashboard,
      saveFile: vi.fn(), memorySetup: {load: vi.fn()}, memoryManagement: {load: vi.fn()},
      recordControlEvent: vi.fn(), confirmDiscard: () => true, eventTarget: {document: {}},
    });
    await workspace.load();
    expect(h.summary.innerHTML).toContain(">2</dd>");
    loadDashboard.mockRejectedValueOnce(new Error("offline"));
    await expect(workspace.load()).resolves.toBe(false);
    expect(h.summary.innerHTML).toContain("Unavailable");
    expect(h.summary.innerHTML).not.toContain(">2</dd>");
    await expect(workspace.load()).resolves.toBe(true);
    expect(h.summary.innerHTML).toContain(">2</dd>");
  });

  test("cleared environment loads discard old counts before the replacement arrives", async () => {
    const h = dashboardDom();
    let complete!: (value: unknown) => void;
    const loadDashboard = vi.fn<() => Promise<unknown>>(async () => ({ dashboard: state().configDashboard }));
    const workspace = createConfigWorkspace({ dom: h.dom, loadDashboard,
      saveFile: vi.fn(), memorySetup: {load: vi.fn()}, memoryManagement: {load: vi.fn()},
      recordControlEvent: vi.fn(), confirmDiscard: () => true, eventTarget: {document: {}},
    });
    await workspace.load();
    loadDashboard.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const loading = workspace.load({ clearBeforeLoad: true, protectUnsaved: false });
    expect(h.summary.innerHTML).toContain("Loading…");
    expect(h.summary.innerHTML).not.toContain(">2</dd>");
    complete({ dashboard: { files: { models: [] } } });
    await loading;
    expect(h.summary.innerHTML).toContain(">0</dd>");
  });

  test("identical owner notifications preserve the rendered nodes despite HTML serialization", () => {
    let writes = 0;
    let serialized = "";
    const element = {
      setAttribute: vi.fn(),
      get innerHTML() { return serialized; },
      set innerHTML(markup: string) {
        writes += 1;
        serialized = markup.replace("data-config-summary-status role", 'data-config-summary-status="" role');
      },
    };
    const root = { querySelector: () => element };
    const summary = modelSummary(state(), () => false);
    syncConfigurationSummary(root, summary);
    syncConfigurationSummary(root, structuredClone(summary));
    expect(writes).toBe(1);
    expect(element.setAttribute).toHaveBeenCalledTimes(1);
    syncConfigurationSummary(root, modelSummary(state(), () => true));
    expect(writes).toBe(2);
  });

  test("summary payloads escape labels, values and hover descriptions", () => {
    const html = renderConfigurationSummary({ label: '\"><script>bad</script>', items: [{label: "<b>event</b>", value: '\"><img src=x>'}] });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;b&gt;event&lt;/b&gt;");
  });
});
