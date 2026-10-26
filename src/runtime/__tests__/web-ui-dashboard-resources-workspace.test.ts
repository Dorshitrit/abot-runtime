import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardWorkspace } from "../../web-ui/app/components/dashboard/workspace.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardFeature } from "../../web-ui/app/dashboard-feature.js";
import { projectBasketAttention } from "../../web-ui/app/lib/information-basket-attention.js";
import { attentionSource, basketView, replacementPath, resourcesFixture } from "./support/dashboard-resources-fixture.js";
import { createHomeWidgetsHarness, type HomeWidgetElement } from "./support/home-widgets-harness.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.unstubAllGlobals();
});
const loaded = {
  environmentId: "dev", composerAvailable: true, supportsSchedules: false,
  sessions: [], runs: [], approvals: [], loadingSessions: false, loadingActivity: false,
};
const attention = {
  supported: true, issues: projectBasketAttention(basketView()),
  error: "", mutation: "", mutationError: "", message: "", loading: false,
  picker: { open: false },
};
function createWorkspace(width = 1280) {
  const h = createHomeWidgetsHarness(width);
  const actions = {
    createJob: vi.fn(), continueConversation: vi.fn(), openJobs: vi.fn(),
    openConversation: vi.fn(), refresh: vi.fn(), decideApproval: vi.fn(), resourceAction: vi.fn(),
    resourcePicker: {
      close: vi.fn(), browse: vi.fn(), addDraft: vi.fn(), submit: vi.fn(), more: vi.fn(),
      selectAll: vi.fn(), clearSelection: vi.fn(), browseDraft: vi.fn(), setPath: vi.fn(), select: vi.fn(),
    },
  };
  const workspace = createDashboardWorkspace({ root: h.root, actions });
  workspace.render({ ...loaded, resourceAttention: attention });
  disposers.push(workspace.compactWidgets.dispose);
  const panel = h.root.querySelector("[data-dashboard-resources]") as HomeWidgetElement;
  return { ...h, workspace, actions, panel };
}

describe("Home Resources desktop and compact layout", () => {
  test("keeps exact source action bindings through expansion and current metadata refresh", () => {
    const h = createWorkspace();
    expect(h.button("resources")!.hidden).toBe(false);
    expect(h.button("resources")!.textContent).toContain("Project notes.md");
    expect(h.workspace.compactWidgets.open("resources")).toBe(true);
    expect(h.dialog()!.contains(h.panel)).toBe(true);
    h.workspace.render({ ...loaded, resourceAttention: {
      ...attention, issues: projectBasketAttention(basketView([{ ...attentionSource, revision: 4 }])),
    } });
    h.panel.querySelector(".home-resource-action")!.dispatch("click");
    expect(h.actions.resourceAction).toHaveBeenCalledExactlyOnceWith("reindex", "source-a", 4);
    expect(h.root.querySelectorAll("[data-dashboard-resources]")).toEqual([h.panel]);
    h.workspace.compactWidgets.close();
    expect(h.panel.parentElement).toBe(h.root.querySelector(".home-workspace-content"));
  });

  test("hides the card and closes its compact dialog when the last problem resolves", () => {
    const h = createWorkspace();
    h.workspace.compactWidgets.open("resources");
    h.workspace.render({ ...loaded, resourceAttention: { ...attention, issues: [], message: "Source queued for indexing." } });
    expect(h.panel.hidden).toBe(true);
    expect(h.button("resources")!.hidden).toBe(true);
    expect(h.dialog()!.open).toBe(false);
    expect(h.workspace.compactWidgets.open("resources")).toBe(false);
    expect(h.panel.parentElement).toBe(h.root.querySelector(".home-workspace-content"));
  });

  test("failed metadata keeps the card visible and disables source actions but allows retry", () => {
    const h = createWorkspace();
    h.workspace.render({ ...loaded, resourceAttention: { ...attention, error: "Status may be out of date." } });
    expect(h.panel.hidden).toBe(false);
    expect(h.button("resources")!.textContent).toContain("Last known status");
    expect(h.button("resources")!.textContent).toContain("could not be refreshed");
    h.workspace.compactWidgets.open("resources");
    h.panel.querySelector(".home-resource-action")!.dispatch("click");
    expect(h.actions.resourceAction).not.toHaveBeenCalled();
    h.panel.querySelector('[data-dashboard-resource-action="refresh"]')!.dispatch("click");
    expect(h.actions.resourceAction).toHaveBeenCalledExactlyOnceWith("refresh", undefined, NaN);
  });

  test("desktop card preserves the composer and does not create another Resources or conversation surface", () => {
    const h = createWorkspace(1600);
    const composer = h.createElement("textarea");
    composer.value = "Keep my unsent message";
    h.workspace.composerHost.append(composer);
    h.workspace.render({ ...loaded, resourceAttention: attention });
    expect(h.panel.hidden).toBe(false);
    expect(h.workspace.compactWidgets.open("resources")).toBe(false);
    expect(h.workspace.composerHost.contains(composer)).toBe(true);
    expect(composer.value).toBe("Keep my unsent message");
    expect(h.root.querySelectorAll(".home-resources-attention")).toHaveLength(1);
    expect(h.actions.openConversation).not.toHaveBeenCalled();
    expect(h.actions.createJob).not.toHaveBeenCalled();
  });

  test("onboarding hides Resources and closes a previously open picker even with a stale open snapshot", () => {
    const h = createWorkspace();
    const picker = {
      open: true, loading: false, selectingAll: false, page: null, selectedPaths: [],
      pathDraft: "", linkId: "source-a", linkName: attentionSource.displayName, error: "",
    };
    h.workspace.render({ ...loaded, resourceAttention: { ...attention, picker } });
    const dialog = h.root.querySelector("dialog.basket-picker-dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.attributes.get("aria-labelledby")).toBe("home-resource-picker-title");
    expect(dialog.querySelector("h2")!.textContent).toBe("Relink source");
    h.workspace.render({ ...loaded, composerAvailable: false, resourceAttention: { ...attention, picker } });
    expect(h.panel.hidden).toBe(true);
    expect(h.panel.innerHTML).toBe("");
    expect(dialog.open).toBe(false);
    expect(h.workspace.compactWidgets.open("resources")).toBe(false);
  });

  test("unsupported backends do not expose the card or its compact widget", () => {
    const h = createWorkspace();
    h.workspace.render({ ...loaded, resourceAttention: { ...attention, supported: false } });
    expect(h.panel.hidden).toBe(true);
    expect(h.button("resources")!.hidden).toBe(true);
  });
});

function createFeature(source = attentionSource) {
  const h = createHomeWidgetsHarness();
  Object.assign(h.documentRoot, { visibilityState: "visible" });
  vi.stubGlobal("document", h.documentRoot);
  const f = resourcesFixture({ view: basketView([source]) });
  let activeWorkspace = "home";
  const shell = {
    activeWorkspace: () => activeWorkspace,
    activateWorkspace: vi.fn((name: string) => { activeWorkspace = name; }),
    showToast: vi.fn(), setSessionsDrawerOpen: vi.fn(),
  };
  const client = {
    ...f.client, supportsSchedules: () => false,
    supportsAutomations: () => false, supportsToolApprovals: () => false,
  };
  const feature = createDashboardFeature({
    dom: { homeDashboardRoot: h.root, modelSelect: { value: "model" } },
    state: { sessions: [] }, client, shell, schedules: { createJob: vi.fn() },
    selectedEnvironmentId: () => "dev", loadSessions: vi.fn(async () => {}),
    openSession: vi.fn(), isComposerAvailable: () => true,
  });
  disposers.push(feature.compactWidgets.dispose);
  feature.setActive(true);
  feature.setReady();
  return { ...h, ...f, client, feature, shell };
}

describe("Home Resources feature action wiring", () => {
  test("relink opens the Runtime picker and sends the selected path for that exact source and revision", async () => {
    const h = createFeature({ ...attentionSource, status: "missing", reason: "basket_source_not_found" });
    await vi.waitFor(() => expect(h.client.listInformationBasket).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.root.querySelector(".home-resource-action")).not.toBeNull());
    h.feature.compactWidgets.open("resources");
    h.root.querySelector(".home-resource-action")!.dispatch("click");
    await vi.waitFor(() => expect(h.client.browseInformationBasket).toHaveBeenCalledOnce());
    const dialog = h.root.querySelector("dialog.basket-picker-dialog")!;
    await vi.waitFor(() => expect(dialog.querySelector("[data-basket-picker-select]")).not.toBeNull());
    expect(h.dialog()!.open).toBe(false);
    expect(dialog.open).toBe(true);
    expect(h.client.relinkInformationBasketSource).not.toHaveBeenCalled();
    dialog.querySelector("[data-basket-picker-select]")!.dispatch("change");
    expect(dialog.querySelector("[data-basket-picker-add]")!.textContent).toBe("Relink source");
    dialog.querySelector("[data-basket-picker-add]")!.dispatch("click");
    await vi.waitFor(() => expect(h.client.relinkInformationBasketSource).toHaveBeenCalledExactlyOnceWith("source-a", 3, replacementPath, "dev"));
    await vi.waitFor(() => expect(dialog.open).toBe(false));
    expect(h.shell.activateWorkspace).not.toHaveBeenCalled();
    expect(h.shell.showToast).toHaveBeenCalledExactlyOnceWith("Source relinked and queued for indexing.", "success");
  });

  test.each([
    ["basket_embedding_profile_required", "settings"],
    ["unknown_failure", "review"],
  ])("routes %s to Resources without mutating a source", async (reason, action) => {
    const h = createFeature({ ...attentionSource, status: "failed", reason });
    await vi.waitFor(() => expect(h.root.querySelector(".home-resource-action")).not.toBeNull());
    const button = h.root.querySelector(".home-resource-action")!;
    expect(button.dataset.dashboardResourceAction).toBe(action);
    button.dispatch("click");
    expect(h.shell.activateWorkspace).toHaveBeenCalledExactlyOnceWith("resources");
    expect(h.client.reindexInformationBasketSource).not.toHaveBeenCalled();
    expect(h.client.relinkInformationBasketSource).not.toHaveBeenCalled();
    expect(h.client.browseInformationBasket).not.toHaveBeenCalled();
  });
});
