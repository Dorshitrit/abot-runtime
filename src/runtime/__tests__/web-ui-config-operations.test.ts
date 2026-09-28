import { describe, expect, test, vi } from "vitest";
import { ContextElement } from "./support/composer-context-window-dom.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigWorkspaceView } from "../../web-ui/app/components/config-workspace/workspace-view.js";
// @ts-expect-error Browser component has no declaration surface.
import { createConfigWorkspace } from "../../web-ui/app/components/config-workspace.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigDashboardRendering } from "../../web-ui/app/components/config-workspace/dashboard-rendering.js";
// @ts-expect-error Browser component has no declaration surface.
import { createOperationsSection } from "../../web-ui/app/components/operations-section.js";

class OperationElement extends ContextElement {
  inert = false;
  value = "";
  focus = vi.fn();
  appendChild(child: ContextElement) {
    const previous = child.parentElement;
    if (previous) previous.children.splice(previous.children.indexOf(child), 1);
    return super.appendChild(child);
  }
  closest(selector: string): ContextElement | null {
    if (this.matches(selector)) return this;
    return (
      (this.parentElement as OperationElement | null)?.closest(selector) ?? null
    );
  }
  matches(selector: string) {
    if (selector === "[data-config-action]")
      return Boolean(this.dataset.configAction);
    if (selector === "[data-config-category-panel]")
      return Boolean(this.dataset.configCategoryPanel);
    return super.matches(selector);
  }
  querySelectorAll(selector: string): ContextElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...(child as OperationElement).querySelectorAll(selector),
    ]);
  }
}

class DashboardElement extends OperationElement {
  writes = 0;
  private markup = "";
  get innerHTML() {
    return this.markup;
  }
  set innerHTML(value: string) {
    this.markup = value;
    this.writes += 1;
    this.replaceChildren();
    for (const section of value.matchAll(/<section\b[^>]*>/g)) {
      const attributes = section[0];
      const category = attributes.match(/data-config-category-panel="([^"]+)"/)?.[1];
      if (!category) continue;
      const panel = new OperationElement("section");
      panel.id = attributes.match(/\bid="([^"]+)"/)?.[1] || "";
      panel.dataset.configCategoryPanel = category;
      panel.classList.add("config-category-panel");
      panel.hidden = /\bhidden\b/.test(attributes);
      for (const name of ["role", "aria-label"]) {
        const value = attributes.match(new RegExp(name + '="([^"]+)"'))?.[1];
        if (value) panel.setAttribute(name, value);
      }
      this.append(panel);
    }
  }
}

function fixture(render = true) {
  const body = new OperationElement("div");
  const dashboard = new DashboardElement("div");
  const operations = new OperationElement("section");
  operations.id = "configOperationsSection";
  operations.hidden = true;
  const buttons = ["runtime", "logs", "health"].map((tab) => {
    const button = new OperationElement("button");
    button.dataset.tab = tab;
    return button;
  });
  const pages = ["runtime", "logs", "health"].map((tab) => {
    const page = new OperationElement("section");
    page.id = tab + "Tab";
    return page;
  });
  const refreshLogs = new OperationElement("button");
  refreshLogs.id = "refreshLogsButton";
  const loadLogs = vi.fn();
  refreshLogs.addEventListener("click", loadLogs);
  const logs = new OperationElement("pre");
  logs.textContent = "Already loaded log lines";
  pages[1]!.append(refreshLogs, logs);
  operations.append(...buttons, ...pages);
  body.append(dashboard, operations);
  const inner = createOperationsSection({ buttons, pages });
  inner.bind();
  inner.activateTab("runtime");
  const state = {
    activeCategory: "models",
    selectedConfigModelId: "",
    loading: false,
    configDashboard: { files: { models: [], runtime: { exists: true } } },
    appliedJsonRepairKeys: new Set(),
  };
  const dom = {
    configDashboard: dashboard,
    refreshConfigButton: new OperationElement("button"),
    configStatus: new OperationElement("div"),
  };
  const view = createConfigWorkspaceView({
    state,
    dom,
    eventTarget: { document: { activeElement: null } },
    configFileEntries: () => [],
    dirtyFiles: () => [],
    dashboardIsBusy: () => state.loading,
    ensureRawSelection: vi.fn(),
    renderModelList: () => "",
    renderSelectedModelEditor: () => "",
    selectedRawConfigFile: () => null,
    ...createConfigDashboardRendering({ state }),
  });
  if (render) view.renderConfigDashboard();
  return {
    body,
    dashboard,
    operations,
    inner,
    buttons,
    pages,
    refreshLogs,
    loadLogs,
    logs,
    state,
    view,
    dom,
  };
}

function controllerFixture(loadDashboard: () => Promise<unknown>) {
  const f = fixture(false);
  const onAddModel = vi.fn();
  const workspace = createConfigWorkspace({
    dom: f.dom,
    loadDashboard,
    onAddModel,
    saveFile: vi.fn(),
    recordControlEvent: vi.fn(),
    confirmDiscard: () => true,
    memorySetup: { load: vi.fn() },
    memoryManagement: { load: vi.fn() },
    eventTarget: {
      document: { activeElement: null },
      addEventListener: vi.fn(),
    },
  });
  workspace.bind();
  return { ...f, workspace, onAddModel };
}

describe("Configuration Operations workspace", () => {
  test("shows the selected workspace region while preserving model drafts during view switches", () => {
    const f = fixture();
    const models = f.dashboard.querySelector("#configModelsPanel")!;
    const operationsPanel = f.dashboard.querySelector(
      "#configOperationsPanel",
    )!;
    const draft = new OperationElement("input");
    draft.value = "Unsaved model name";
    models.appendChild(draft);
    const writes = f.dashboard.writes;
    expect(operationsPanel.hidden).toBe(true);
    expect(f.operations.parentElement).toBe(operationsPanel);
    expect(f.body.children).not.toContain(f.operations);
    f.view.activateCategory("operations");
    expect(operationsPanel.hidden).toBe(false);
    expect(models.hidden).toBe(true);
    expect(operationsPanel.getAttribute("role")).toBe("region");
    expect(operationsPanel.getAttribute("aria-label")).toBeTruthy();
    expect(f.dashboard.querySelectorAll("[data-config-category-panel]")).toHaveLength(3);
    f.view.activateCategory("plugins");
    expect(operationsPanel.hidden).toBe(true);
    f.view.activateCategory("models");
    expect(models.children[0]).toBe(draft);
    expect(draft.value).toBe("Unsaved model name");
    expect(f.dashboard.writes).toBe(writes);
    expect(f.loadLogs).not.toHaveBeenCalled();
  });

  test("reattaches the original Operations subtree and listeners after dashboard rerenders without resetting its inner view", () => {
    const f = fixture();
    f.view.activateCategory("operations");
    f.buttons[1]!.dispatch("click");
    expect(f.inner.activeTab()).toBe("logs");
    const previousPanel = f.operations.parentElement;
    f.view.renderConfigDashboard();
    expect(f.operations.parentElement).not.toBe(previousPanel);
    expect(f.operations.parentElement).toBe(
      f.dashboard.querySelector("#configOperationsPanel"),
    );
    expect(f.operations.parentElement!.hidden).toBe(false);
    expect(f.operations.querySelector("#refreshLogsButton")).toBe(
      f.refreshLogs,
    );
    expect(f.logs.textContent).toBe("Already loaded log lines");
    expect(f.inner.activeTab()).toBe("logs");
    expect(f.pages[1]!.hidden).toBe(false);
    expect(f.pages[0]!.hidden).toBe(true);
    expect(f.loadLogs).not.toHaveBeenCalled();
    f.refreshLogs.dispatch("click");
    expect(f.loadLogs).toHaveBeenCalledOnce();
    f.view.activateCategory("models");
    f.view.activateCategory("operations");
    f.buttons[2]!.dispatch("click");
    expect(f.inner.activeTab()).toBe("health");
    expect(f.pages[2]!.hidden).toBe(false);
    expect(f.pages[1]!.hidden).toBe(true);
    expect(f.loadLogs).toHaveBeenCalledOnce();
  });
  test("keeps workspace navigation and diagnostics available through startup failure while loading locks config mutations", async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const f = controllerFixture(() => pending);
    const load = f.workspace.load();
    const models = f.dashboard.querySelector(
      "#configModelsPanel",
    ) as OperationElement;
    const operations = f.dashboard.querySelector(
      "#configOperationsPanel",
    ) as OperationElement;
    expect(f.dashboard.inert).toBe(false);
    expect(models.inert).toBe(true);
    expect(operations.inert).toBe(false);
    expect(f.dom.refreshConfigButton.disabled).toBe(true);
    f.workspace.setWorkspace("config");
    expect(f.workspace.activeCategory()).toBe("operations");
    expect(operations.hidden).toBe(false);
    f.refreshLogs.dispatch("click");
    expect(f.loadLogs).toHaveBeenCalledOnce();
    const addModel = new OperationElement("button");
    addModel.dataset.configAction = "add-model";
    f.dashboard.dispatch("click", { target: addModel });
    expect(f.onAddModel).not.toHaveBeenCalled();
    f.workspace.setWorkspace("models");
    expect(f.workspace.activeCategory()).toBe("models");
    expect(models.hidden).toBe(false);
    expect(operations.hidden).toBe(true);
    reject(new Error("Configuration unavailable"));
    await expect(load).resolves.toBe(false);
    expect(f.dom.configStatus.textContent).toBe("Configuration unavailable");
    expect(f.dashboard.innerHTML).toContain("No config dashboard data");
    expect(
      f.dashboard.querySelector("#configOperationsPanel")!.children[0],
    ).toBe(f.operations);
    expect(f.dom.refreshConfigButton.disabled).toBe(false);
    expect(
      (f.dashboard.querySelector("#configModelsPanel") as OperationElement)
        .inert,
    ).toBe(false);
  });

  test("preserves diagnostic nodes and inner selection through a cleared snapshot, failed load, and recovery", async () => {
    const payload = { dashboard: { files: { models: [] } } };
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(payload)
      .mockRejectedValueOnce(new Error("Environment unavailable"))
      .mockResolvedValueOnce(payload);
    const f = controllerFixture(loadDashboard);
    await expect(f.workspace.load()).resolves.toBe(true);
    f.workspace.setWorkspace("config");
    f.buttons[1]!.dispatch("click");
    await expect(
      f.workspace.load({ clearBeforeLoad: true, protectUnsaved: false }),
    ).resolves.toBe(false);
    expect(f.dom.configStatus.textContent).toBe("Environment unavailable");
    expect(f.dashboard.innerHTML).toContain("No config dashboard data");
    const unavailablePanel = f.dashboard.querySelector(
      "#configOperationsPanel",
    )!;
    expect(unavailablePanel.hidden).toBe(false);
    expect(unavailablePanel.children[0]).toBe(f.operations);
    expect(f.operations.querySelector("#refreshLogsButton")).toBe(
      f.refreshLogs,
    );
    expect(f.inner.activeTab()).toBe("logs");
    f.refreshLogs.dispatch("click");
    await expect(f.workspace.load()).resolves.toBe(true);
    expect(f.dashboard.innerHTML).not.toContain("No config dashboard data");
    expect(
      f.dashboard.querySelector("#configOperationsPanel")!.children[0],
    ).toBe(f.operations);
    expect(f.inner.activeTab()).toBe("logs");
    expect(f.logs.textContent).toBe("Already loaded log lines");
    f.refreshLogs.dispatch("click");
    expect(f.loadLogs).toHaveBeenCalledTimes(2);
    expect(loadDashboard).toHaveBeenCalledTimes(3);
  });
});
