import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only component has no declaration surface.
import { createLearningApplications, learningApplicationsMarkup } from "../../web-ui/app/components/passive-learning/applications-view.js";
// @ts-expect-error Browser-only action owner has no declaration surface.
import { learningApplicationPreferenceChange } from "../../web-ui/app/components/passive-learning/application-actions.js";
// @ts-expect-error Browser-only workspace view has no declaration surface.
import { learningWorkspaceMarkup, navigateLearningTabs } from "../../web-ui/app/components/passive-learning/workspace-view.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

type Application = { app: string; observationCount: number; lastObservedAt?: string; collectionExcluded: boolean; processingExcluded: boolean };
type Checkbox = FakeElement & { checked: boolean };
const application = (app: string, overrides: Partial<Application> = {}): Application => ({
  app, observationCount: 3, lastObservedAt: "2026-09-25T14:00:00.000Z", collectionExcluded: false, processingExcluded: false, ...overrides,
});
function initialSnapshot() {
  return { environmentId: "dev", saving: false, statusError: "", loadingStatus: false, status: {
    preferences: { excludedApplications: ["Terminal"], processingExcludedApplications: ["Firefox"] },
    applications: [application("Firefox", { processingExcluded: true }), application("Terminal", {
      observationCount: 0, lastObservedAt: undefined, collectionExcluded: true,
    })], applicationsOmitted: 0,
  } };
}
function rootElement(markup: string) {
  const documentRoot = { activeElement: null as FakeElement | null } as FakeElement["ownerDocument"];
  documentRoot.createElement = tag => new FakeElement(tag, documentRoot);
  const root = documentRoot.createElement("div"); root.innerHTML = markup;
  return root;
}
function harness() {
  const snapshot = initialSnapshot();
  const root = rootElement(learningApplicationsMarkup());
  const actions = { snapshot: () => snapshot, configure: vi.fn(async (_patch: Record<string, string[]>) => {}) };
  const view = createLearningApplications({ root, actions });
  view.render(snapshot);
  const row = (app: string) => root.querySelectorAll("[data-learning-application]").find(item => item.dataset.learningApplication === app)!;
  const input = (app: string, axis: string) => row(app).querySelector(`[data-learning-application-axis="${axis}"]`) as Checkbox;
  return { root, actions, snapshot, view, row, input };
}

describe("Co-worker application controls", () => {
  test("shows retained counts and independent permissions, including excluded apps without activity", () => {
    const h = harness();
    expect(h.row("Firefox").textContent).toContain("3 retained observations");
    expect(h.row("Terminal").textContent).toContain("No retained activity");
    expect(h.row("Terminal").textContent).not.toContain("Last collected");
    expect(h.input("Firefox", "collection").checked).toBe(true);
    expect(h.input("Firefox", "processing").checked).toBe(false);
    expect(h.input("Terminal", "collection").checked).toBe(false);
    expect(h.input("Terminal", "processing").checked).toBe(true);
    expect(h.input("Firefox", "collection").attributes.get("aria-label")).toBe("Collect activity · Firefox");
    expect(h.root.textContent).toContain("expiry and storage limits");
    h.snapshot.status.applicationsOmitted = 12; h.view.render(h.snapshot);
    expect(h.root.querySelector("[data-learning-applications-count]")?.textContent).toContain("12 older applications not shown");
  });

  test("treats source names as text and preserves focused controls on status refresh", () => {
    const h = harness();
    const maliciousName = '<img src=x onerror="alert(1)">';
    h.snapshot.status.applications.push(application(maliciousName)); h.view.render(h.snapshot);
    expect(h.row(maliciousName).querySelector("h5")?.textContent).toBe(maliciousName);
    expect(h.row(maliciousName).querySelector("img")).toBe(null);
    const input = h.input("Firefox", "collection"); input.focus();
    h.snapshot.status.applications[0].observationCount = 7; h.view.render(h.snapshot);
    expect(h.input("Firefox", "collection")).toBe(input);
    expect(h.root.ownerDocument.activeElement).toBe(input);
    expect(h.row("Firefox").textContent).toContain("7 retained observations");
  });

  test("saves once for input plus change, restores server state, and disables changes while saving", async () => {
    const h = harness();
    h.actions.configure.mockImplementation(async () => { h.snapshot.saving = true; });
    const input = h.input("Firefox", "collection"); input.checked = false;
    h.view.handleChange({ type: "input", target: input });
    expect(h.actions.configure).not.toHaveBeenCalled();
    h.view.handleChange({ type: "change", target: input });
    expect(h.actions.configure).toHaveBeenCalledExactlyOnceWith({ excludedApplications: ["Terminal", "Firefox"] });
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
    h.view.handleChange({ type: "change", target: input });
    expect(h.actions.configure).toHaveBeenCalledTimes(1);
    h.snapshot.saving = false;
    h.snapshot.status.preferences.excludedApplications.push("Firefox");
    h.snapshot.status.applications[0].collectionExcluded = true; h.view.render(h.snapshot);
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(false);
  });

  test("keeps failed saves unchanged and requires a status refresh before another change", () => {
    const h = harness();
    const input = h.input("Firefox", "processing"); input.checked = true;
    h.snapshot.statusError = "configure failed"; h.view.handleChange({ type: "change", target: input });
    expect(h.actions.configure).not.toHaveBeenCalled();
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(true);
    expect(h.root.textContent).toContain("Refresh before changing permissions");
  });

  test("rejects an event from a previous environment before replacing its rows", () => {
    const h = harness();
    const oldInput = h.input("Firefox", "collection"); oldInput.checked = false;
    h.snapshot.environmentId = "staging";
    h.view.handleChange({ type: "change", target: oldInput });
    expect(h.actions.configure).not.toHaveBeenCalled();
    expect(h.input("Firefox", "collection")).not.toBe(oldInput);
    expect(h.view.handleChange({ type: "change", target: oldInput })).toBe(false);
  });

  test("removes expired entries and keeps the empty state separate from a load failure", () => {
    const h = harness();
    h.snapshot.status.applications = []; h.view.render(h.snapshot);
    expect(h.root.querySelectorAll("[data-learning-application]")).toHaveLength(0);
    expect(h.root.textContent).toContain("Excluded apps stay listed");
    h.view.render({ ...h.snapshot, status: null, statusError: "unavailable" });
    expect(h.root.textContent).toContain("Application history is unavailable");
  });
});

describe("Co-worker application preference patches", () => {
  test("matches app identity case-insensitively and changes only the selected permission list", () => {
    const snapshot = initialSnapshot();
    snapshot.status.preferences.processingExcludedApplications = [" firefox ", "FIREFOX", "Editor"];
    const change = { app: "firefox", axis: "processing", allowed: true, environmentId: "dev" };
    expect(learningApplicationPreferenceChange(snapshot, change)).toEqual({ processingExcludedApplications: ["Editor"] });
    expect(snapshot.status.preferences.excludedApplications).toEqual(["Terminal"]);
    expect(learningApplicationPreferenceChange(snapshot, { ...change, allowed: false }))
      .toEqual({ processingExcludedApplications: ["Editor", "Firefox"] });
  });

  test.each([
    { app: "Unknown" }, { axis: "constructor" }, { axis: "unsupported" }, { allowed: "false" }, { environmentId: "staging" },
  ])("rejects forged or stale changes: %j", override => {
    expect(learningApplicationPreferenceChange(initialSnapshot(), {
      app: "Firefox", axis: "collection", allowed: false, environmentId: "dev", ...override,
    })).toBe(null);
  });
});

test("Applications participates in keyboard tab navigation and exposes one selected panel", () => {
  const root = rootElement(learningWorkspaceMarkup("UTC"));
  expect(root.querySelectorAll("[data-learning-tab]")).toHaveLength(5);
  const event = { target: root.querySelector('[data-learning-tab="activity"]'), key: "ArrowRight", preventDefault: vi.fn() };
  navigateLearningTabs(root, event);
  const tab = root.querySelector('[data-learning-tab="applications"]')!;
  expect(tab.attributes.get("aria-selected")).toBe("true");
  expect(root.ownerDocument.activeElement).toBe(tab);
  expect(root.querySelectorAll("[data-learning-panel]").filter(panel => !panel.hidden)).toHaveLength(1);
  expect(root.querySelector('[data-learning-panel="applications"]')?.hidden).toBe(false);
  navigateLearningTabs(root, { ...event, target: tab, key: "ArrowRight" });
  expect(root.querySelector('[data-learning-tab="settings"]')?.attributes.get("aria-selected")).toBe("true");
});
