import { expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";
// @ts-expect-error Browser-only module.
import { createInformationBasketWorkspace } from "../../web-ui/app/components/information-basket/workspace.js";
// @ts-expect-error Browser-only module.
import { renderBasketSourceRows, renderBasketSourceDetails } from "../../web-ui/app/components/information-basket/resource-rows.js";
// @ts-expect-error Browser-only module.
import { renderBasketPickerEntries } from "../../web-ui/app/components/information-basket/source-picker.js";
// @ts-expect-error Browser-only module.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
import { readWorkspaceRoute, workspaceRouteUrl } from "../../web-ui/app/lib/workspace-route.js";

const source = { sourceId: "source-a", displayName: "Notes.md", path: "/documents/Notes.md", revision: 3,
  status: "ready", sizeBytes: 100, chunkCount: 2, indexedAt: "2026-10-25T10:00:00Z", reason: null };
const settings = { matchMode: "balanced", indexChatUploads: false, revision: 1, enabled: true, embeddingProfileId: "local" };
const snapshot = { view: { settings, sources: [source], embeddingProfiles: [{ id: "local", label: "Local", model: "embed" }], supportedExtensions: [".md", ".pdf"] },
  settingsDraft: settings, settingsDirty: false, sources: [source], visibleSources: [source], selected: [], detail: null,
  loading: false, mutation: "", error: "", message: "", picker: { open: false, page: null, selectedPaths: [], pathDraft: "" } };
function fixture() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html"); document.body = document.createElement("body");
  const root = document.createElement("section"); document.body.append(root);
  const actions = { picker: { open: vi.fn(), close: vi.fn(), browse: vi.fn(), select: vi.fn(), selectAll: vi.fn(), clearSelection: vi.fn(), submit: vi.fn(), setPath: vi.fn(), browseDraft: vi.fn(), addDraft: vi.fn(), more: vi.fn() },
    refresh: vi.fn(), saveSettings: vi.fn(), resetSettings: vi.fn(), showDetails: vi.fn(), reindex: vi.fn(), remove: vi.fn(),
    setQuery: vi.fn(), setFilter: vi.fn(), changeSettings: vi.fn(), select: vi.fn(), selectVisible: vi.fn() };
  const view = createInformationBasketWorkspace({ root, actions, documentRoot: document });
  view.render(snapshot);
  return { root, actions, view };
}

test("source and picker projections escape untrusted filenames, paths and reasons", () => {
  const hostile = { ...source, sourceId: '\" onclick=\"bad()', displayName: '<img src=x onerror=bad()>', path: '/documents/<script>bad()</script>', reason: '<b>bad</b>' };
  const rows = renderBasketSourceRows({ ...snapshot, visibleSources: [hostile] });
  expect(rows).toContain("&lt;img"); expect(rows).toContain("&lt;script&gt;"); expect(rows).toContain("&quot;");
  expect(rows).not.toContain("<img"); expect(rows).not.toContain("<script>");
  expect(renderBasketSourceDetails(hostile)).toContain("&lt;b&gt;bad&lt;/b&gt;");
  const picker = renderBasketPickerEntries({ page: { entries: [{ name: hostile.displayName, path: hostile.path, kind: "file", supported: false }] } });
  expect(picker).toContain("disabled"); expect(picker).toContain("Unsupported"); expect(picker).not.toContain("<img");
});

test("real UI actions target source IDs and source path linking remains explicit", () => {
  const f = fixture();
  f.root.querySelector("[data-basket-choose]")!.dispatch("click"); expect(f.actions.picker.open).toHaveBeenCalledOnce();
  f.root.querySelector("[data-basket-detail]")!.dispatch("click"); expect(f.actions.showDetails).toHaveBeenCalledWith(source.sourceId);
  f.root.querySelector("[data-basket-reindex]")!.dispatch("click"); expect(f.actions.reindex).toHaveBeenCalledWith([source.sourceId]);
  f.root.querySelector("[data-basket-remove]")!.dispatch("click"); expect(f.actions.remove).toHaveBeenCalledWith([source.sourceId]);
  expect(f.root.querySelector("[data-basket-link]")).toBe(null);
  expect(f.root.querySelector("[data-basket-drop]")).toBe(null);
  expect(f.root.querySelector("[data-basket-add-sources]")).not.toBe(null);
});

test("profile settings require Save and declared formats come from the server", () => {
  const f = fixture();
  expect(f.root.querySelector("[data-basket-settings-save]")!.disabled).toBe(true);
  expect(f.root.querySelector("[data-basket-formats]")!.textContent).toBe("Supported files: .md, .pdf");
  const profile = f.root.querySelector("[data-basket-profile]")!; profile.value = "another"; profile.dispatch("change");
  expect(f.actions.changeSettings).toHaveBeenCalledWith("embeddingProfileId", "another");
  expect(f.actions.saveSettings).not.toHaveBeenCalled();
  f.view.render({ ...snapshot, settingsDirty: true });
  f.root.querySelector("[data-basket-settings-save]")!.dispatch("click"); expect(f.actions.saveSettings).toHaveBeenCalledOnce();
  f.root.querySelector("[data-basket-settings-reset]")!.dispatch("click"); expect(f.actions.resetSettings).toHaveBeenCalledOnce();
});

test("picker selects server-returned paths and keeps its content within a native dialog", () => {
  const f = fixture();
  f.view.render({ ...snapshot, picker: { open: true, page: { directory: "/documents", parent: "/", roots: [], nextCursor: null,
    entries: [{ name: "Notes.md", path: source.path, kind: "file", supported: true }] }, selectedPaths: [], pathDraft: "/documents", loading: false, error: "" } });
  expect(f.root.querySelector("dialog")!.open).toBe(true);
  f.root.querySelector("[data-basket-picker-select]")!.dispatch("change"); expect(f.actions.picker.select).toHaveBeenCalledWith(source.path);
  const path = f.root.querySelector("[data-basket-path]")!; path.value = source.path; path.dispatch("input");
  expect(f.actions.picker.setPath).toHaveBeenCalledWith(source.path);
  f.root.querySelector("[data-basket-path-add]")!.dispatch("click"); expect(f.actions.picker.addDraft).toHaveBeenCalledOnce();
  f.view.render(snapshot); expect(f.root.querySelector("dialog")!.open).toBe(false);
});

test("Resources uses existing shell navigation, focus, backend availability and addresses", async () => {
  const h = createWorkspaceShellHarness(1440);
  const shell = createWorkspaceShell({ ...h }); shell.bind(); shell.load();
  await h.dom.resourcesWorkspaceButton.dispatch("click");
  await vi.waitFor(() => expect(shell.activeWorkspace()).toBe("resources")); h.flushFrames();
  expect(h.dom.resourcesWorkspacePanel.hidden).toBe(false);
  expect(h.dom.resourcesWorkspacePanel.inert).toBe(false);
  expect(h.documentRoot.activeElement).toBe(h.dom.closeResourcesWorkspaceButton);
  expect(shell.closeOverlaysOnEscape()).toBe(true);
  await vi.waitFor(() => expect(shell.activeWorkspace()).toBe("chat"));
  const address = workspaceRouteUrl({ workspace: "resources", environment: "dev one", session: "irrelevant" });
  expect(address).toBe("/resources?environment=dev+one");
  expect(readWorkspaceRoute(new URL(address, "http://localhost"))).toMatchObject({ workspace: "resources", environment: "dev one", session: "" });
  const blocked = createWorkspaceShell({ ...createWorkspaceShellHarness(1440), isWorkspaceAvailable: (name: string) => name !== "resources" });
  blocked.bind(); blocked.load(); expect(await blocked.activateWorkspace("resources")).toBe(false);
});

test("picker exposes folder selection, reports busy state and hides bulk actions for pending links", () => {
  const f = fixture();
  const picker = { open: true, page: { directory: "/documents", parent: "/", roots: [], nextCursor: "next",
    entries: [{ name: "Notes.md", path: source.path, kind: "file", supported: true }] },
    selectedPaths: [source.path], pathDraft: "/documents", loading: false, selectingAll: false, error: "", linkId: "" };
  f.view.render({ ...snapshot, picker });
  f.root.querySelector("[data-basket-picker-select-all]")!.dispatch("click");
  f.root.querySelector("[data-basket-picker-clear]")!.dispatch("click");
  expect(f.actions.picker.selectAll).toHaveBeenCalledOnce();
  expect(f.actions.picker.clearSelection).toHaveBeenCalledOnce();
  expect(f.root.querySelector("[data-basket-picker-count]")!.textContent).toBe("1 selected");
  expect(f.root.querySelector("[data-basket-picker-count]")!.attributes.get("aria-live")).toBe("polite");
  f.view.render({ ...snapshot, picker: { ...picker, loading: true, selectingAll: true } });
  for (const selector of ["select-all", "clear", "add", "select", "more"])
    expect(f.root.querySelector(`[data-basket-picker-${selector}]`)!.disabled).toBe(true);
  expect(f.root.querySelector("[data-basket-picker-entries]")!.attributes.get("aria-busy")).toBe("true");
  expect(f.root.querySelector("[data-basket-picker-count]")!.textContent).toContain("Selecting");
  f.view.render({ ...snapshot, picker: { ...picker, linkId: "pending-1" } });
  expect(f.root.querySelector("[data-basket-picker-selection]")!.hidden).toBe(true);
  f.root.querySelector("[data-basket-picker-select-all]")!.dispatch("click");
  expect(f.actions.picker.selectAll).toHaveBeenCalledOnce();
});

test("status controls show canonical groups and preserve search and selection while filtering", () => {
  const f = fixture();
  const sources = [source, { ...source, sourceId: "queued", status: "queued" },
    { ...source, sourceId: "indexing", status: "indexing" },
    { ...source, sourceId: "missing", status: "missing" },
    { ...source, sourceId: "stale", status: "stale" }];
  f.view.render({ ...snapshot, sources, selected: [source.sourceId], query: "Notes", filter: "ready" });
  const filters = f.root.querySelectorAll("[data-basket-filter]");
  expect(filters.map((button) => button.querySelector("[data-basket-filter-count]")!.textContent)).toEqual(["5", "1", "2", "2"]);
  expect(filters.map((button) => button.attributes.get("aria-pressed"))).toEqual(["false", "true", "false", "false"]);
  filters[3]!.dispatch("click");
  expect(f.actions.setFilter).toHaveBeenCalledWith("attention");
  expect(f.actions.select).not.toHaveBeenCalled();
  expect(f.actions.selectVisible).not.toHaveBeenCalled();
  const search = f.root.querySelector("[data-basket-search]")!;
  expect(search.value).toBe("Notes");
  search.value = "report"; search.dispatch("input");
  expect(f.actions.setQuery).toHaveBeenCalledWith("report");
  f.root.querySelector("[data-basket-refresh]")!.dispatch("click");
  expect(f.actions.refresh).toHaveBeenCalledOnce();
});


test("chat upload switch starts off, edits the settings draft and follows busy state", () => {
  const f = fixture();
  const toggle = f.root.querySelector("[data-basket-chat-uploads]")! as FakeElement & { checked: boolean };
  expect(toggle.checked).toBe(false);
  toggle.checked = true; toggle.dispatch("change");
  expect(f.actions.changeSettings).toHaveBeenCalledWith("indexChatUploads", true);
  expect(f.actions.saveSettings).not.toHaveBeenCalled();
  f.view.render({ ...snapshot, settingsDraft: { ...settings, indexChatUploads: true }, mutation: "settings" });
  expect(toggle.checked).toBe(true);
  expect(toggle.disabled).toBe(true);
});


test("matching selector offers three modes, saves explicitly and disables during mutations", () => {
  const f = fixture();
  const select = f.root.querySelector("[data-basket-match-mode]")!;
  expect(select.value).toBe("balanced");
  expect(select.querySelectorAll("option").map(option => option.attributes.get("value")))
    .toEqual(["flexible", "balanced", "strict"]);
  select.value = "strict"; select.dispatch("change");
  expect(f.actions.changeSettings).toHaveBeenCalledWith("matchMode", "strict");
  expect(f.actions.saveSettings).not.toHaveBeenCalled();
  f.view.render({ ...snapshot, settingsDraft: { ...settings, matchMode: "strict" }, mutation: "settings" });
  expect(select.value).toBe("strict");
  expect(select.disabled).toBe(true);
});
