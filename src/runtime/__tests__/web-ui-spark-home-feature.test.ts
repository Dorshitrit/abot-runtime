import { afterEach, expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
vi.mock("../../web-ui/app/components/confirmation-dialog.js", async original => ({
  ...await original<Record<string, unknown>>(), confirmDialog: vi.fn(async () => true),
}));
// @ts-expect-error Browser feature.
import { createSparkHomeFeature } from "../../web-ui/app/spark-home-feature.js";
// @ts-expect-error Browser markup.
import { learningWorkspaceMarkup } from "../../web-ui/app/components/passive-learning/workspace-view.js";

class Element extends FakeElement {
  get type() { return super.type; }
  set type(value: string) { this.setAttribute("type", value); }
  append(...nodes: FakeElement[]) { for (const node of nodes) super.append(node); }
  appendChild(node: FakeElement) { this.append(node); return node; }
  replaceChildren(...nodes: FakeElement[]) { super.replaceChildren(); this.append(...nodes); }
  get classList() {
    const contains = (name: string) => this.className.split(/\s+/).includes(name);
    const add = (name: string) => { if (!contains(name)) this.className = `${this.className} ${name}`.trim(); };
    const remove = (name: string) => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(" "); };
    return { add, remove, contains, toggle: (name: string, enabled = !contains(name)) => enabled ? add(name) : remove(name) };
  }
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

test("the real HOME feature keeps the chat closed, restores its view and adopts publication without replacing an unchanged frame", async () => {
  vi.useFakeTimers();
  const document = { addEventListener: vi.fn() } as any;
  document.createElement = (tag: string) => new Element(tag, document);
  document.documentElement = document.createElement("html"); document.body = document.createElement("body");
  const homeWorkspacePanel = document.createElement("section");
  const header = document.createElement("header"); header.className = "home-workspace-header";
  const homeDashboardRoot = document.createElement("div"); const ordinaryDraft = document.createElement("textarea");
  ordinaryDraft.value = "Keep my ordinary message"; homeDashboardRoot.append(ordinaryDraft);
  homeWorkspacePanel.append(header, homeDashboardRoot);
  const learningRoot = document.createElement("section"); learningRoot.innerHTML = learningWorkspaceMarkup("UTC");
  const environmentSelect = document.createElement("select"); environmentSelect.value = "dev";
  const dom = { homeWorkspacePanel, homeDashboardRoot, learningRoot, environmentSelect, homeWorkspaceButton: document.createElement("button") };
  const spark = { homeActivityRoot: document.createElement("section"), open: vi.fn(), openModelSettings: vi.fn(), isOpen: () => false };
  const client = {
    supportsSparkChat: () => true,
    getSparkHome: vi.fn(async () => ({ screen: { revision: 1, updatedAt: "first" } })),
    sparkHomeContentUrl: (revision: number) => `/home-content?revision=${revision}`,
    getSparkHomeSettings: vi.fn(async () => ({ settings: { revision: 4, personalInstructions: "My own direction", modelProfileId: "ea",
      available: true, reason: null, calibrationRequired: false, models: [{ id: "ea", label: "EA" }] } })),
    getSparkHomePreferences: vi.fn(async () => ({ preferences: { revision: 2, mode: "spark_home" } })),
    configureSparkHomePreferences: vi.fn(async (input: any) => ({ preferences: { revision: 3, mode: input.mode } })),
    getSparkHomeRun: vi.fn(async (): Promise<{ run: any }> => ({ run: null })),
    startSparkHomeRun: vi.fn(async () => ({ run: { runId: "home-run", revision: 1, status: "running", phase: "plan" } })),
  };
  const listeners: Array<(message: any) => void> = [];
  const shell = { activeWorkspace: () => "home", isWorkspaceAvailable: () => true,
    subscribeWorkspaceChange: vi.fn(), subscribeRuntimeAvailabilityChange: vi.fn() };
  const feature = createSparkHomeFeature({ dom, client, spark, shell, documentRoot: document,
    dashboard: { compactWidgets: { close: vi.fn() } }, getEnvironmentId: () => "dev",
    realtime: { subscribeConnected: vi.fn(), subscribeMessages: (fn: (message: any) => void) => listeners.push(fn) } });
  await feature.environmentChanged();
  const firstFrame = homeWorkspacePanel.querySelector("iframe"); expect(firstFrame).toBeDefined();
  client.getSparkHomeRun.mockResolvedValue({ run: { runId: "home-run", revision: 1, status: "running", phase: "plan" } });
  homeWorkspacePanel.querySelector(".spark-home-toolbar")!.querySelector("button")!.dispatch("click");
  await vi.waitFor(() => expect(client.startSparkHomeRun).toHaveBeenCalledExactlyOnceWith({ expectedSettingsRevision: 4 }, "dev"));
  expect(spark.open).not.toHaveBeenCalled(); expect(ordinaryDraft.value).toBe("Keep my ordinary message");
  expect(homeWorkspacePanel.querySelector("iframe")).toBe(firstFrame);
  expect(homeWorkspacePanel.querySelector(".spark-home-generation")!.hidden).toBe(false);
  client.getSparkHome.mockResolvedValue({ screen: { revision: 2, updatedAt: "second" } });
  client.getSparkHomeRun.mockResolvedValue({ run: { runId: "home-run", revision: 3, status: "completed", phase: "publish", screenRevision: 2 } });
  for (const listener of listeners) listener({ type: "spark_home_changed", environmentId: "dev" });
  await vi.waitFor(() => expect(homeWorkspacePanel.querySelector("iframe")!.getAttribute("src")).toBe("/home-content?revision=2"));
  const published = homeWorkspacePanel.querySelector("iframe"); await feature.refresh();
  expect(homeWorkspacePanel.querySelector("iframe")).toBe(published);
  dom.homeWorkspaceButton.dispatch("click");
  await vi.waitFor(() => expect(client.configureSparkHomePreferences).toHaveBeenCalledWith({ expectedRevision: 2, mode: "dashboard" }, "dev"));
  expect(homeDashboardRoot.hidden).toBe(false);
});
