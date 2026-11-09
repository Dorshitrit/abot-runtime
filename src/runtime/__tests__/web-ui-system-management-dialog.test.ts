import { afterEach, expect, test, vi } from "vitest";
import { managementDialogFixture, managedSkill, managedSource, deferredManagement } from "./support/system-management-dialog-fixture.js";

const fixtures: ReturnType<typeof managementDialogFixture>[] = [];
function fixture(overrides = {}) { const f = managementDialogFixture(overrides); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.manager.destroy(); });

test("embedded Skills reuses creation, exact-revision editing, archive confirmation and restore", async () => {
  const f = fixture();
  expect(await f.manager.open("skills", { id: managedSkill.skillId })).toBe(true);
  expect(f.root.open).toBe(true);
  f.input("[data-skills-content]", "Changed guidance");
  f.find("[data-skills-form]").dispatch("submit");
  await vi.waitFor(() => expect(f.client.updatePersonalSkill).toHaveBeenCalledWith(managedSkill.skillId, "Changed guidance", 2, "dev"));
  await vi.waitFor(() => expect(f.manager.isBusy()).toBe(false));
  f.find("[data-skills-archive]").dispatch("click");
  expect(f.client.archivePersonalSkill).not.toHaveBeenCalled();
  f.confirm(true);
  await vi.waitFor(() => expect(f.client.archivePersonalSkill).toHaveBeenCalledWith(managedSkill.skillId, 3, "dev"));
  await vi.waitFor(() => expect(f.manager.isBusy()).toBe(false));
  f.find('[data-skills-filter="archived"]').dispatch("click");
  await vi.waitFor(() => expect(f.find("[data-skill-id]")).not.toBeNull());
  f.find("[data-skill-id]").dispatch("click");
  await vi.waitFor(() => expect(f.find("[data-skills-restore]").hidden).toBe(false));
  f.find("[data-skills-restore]").dispatch("click");
  await vi.waitFor(() => expect(f.client.restorePersonalSkill).toHaveBeenCalledWith(managedSkill.skillId, 4, "dev"));
  await vi.waitFor(() => expect(f.manager.isBusy()).toBe(false));
  f.find("[data-skills-new]").dispatch("click");
  await vi.waitFor(() => expect(f.find("[data-skills-creation-fields]").hidden).toBe(false));
  f.input("[data-skills-new-name]", "New guide"); f.input("[data-skills-new-description]", "New description");
  f.input("[data-skills-content]", "New content"); f.find("[data-skills-form]").dispatch("submit");
  await vi.waitFor(() => expect(f.client.createPersonalSkill).toHaveBeenCalledWith({ name: "New guide", description: "New description", content: "New content" }, "dev"));
  await vi.waitFor(() => expect(f.manager.isBusy()).toBe(false));
  expect(f.onChanged).toHaveBeenCalledWith("skills");
  expect(await f.manager.close()).toBe(true);
  expect(f.documentRoot.activeElement).toBe(f.trigger);
});

test("embedded Resources reuses settings save, reindex, native picker and confirmed removal", async () => {
  const f = fixture(); await f.manager.open("resources");
  const mode = f.find("[data-basket-match-mode]"); mode.value = "strict"; mode.dispatch("change");
  expect(f.manager.isDirty()).toBe(true);
  f.find("[data-basket-settings-save]").dispatch("click");
  await vi.waitFor(() => expect(f.client.saveInformationBasketSettings).toHaveBeenCalledWith(expect.objectContaining({ matchMode: "strict", expectedRevision: 1 }), "dev"));
  await vi.waitFor(() => expect(f.manager.isBusy()).toBe(false));
  f.find("[data-basket-reindex]").dispatch("click");
  await vi.waitFor(() => expect(f.client.reindexInformationBasketSource).toHaveBeenCalledWith(managedSource.sourceId, 3, "dev"));
  await vi.waitFor(() => expect(f.manager.isBusy()).toBe(false));
  f.find("[data-basket-choose]").dispatch("click");
  await vi.waitFor(() => expect(f.find("[data-basket-picker-select]")).not.toBeNull());
  expect(f.find(".basket-picker-dialog").open).toBe(true);
  f.find("[data-basket-picker-select]").dispatch("change");
  f.find("[data-basket-picker-add]").dispatch("click");
  await vi.waitFor(() => expect(f.client.registerInformationBasketSources).toHaveBeenCalledWith(["/documents/Next.md"], "dev"));
  await vi.waitFor(() => expect(f.find(".basket-picker-dialog").open).toBe(false));
  f.find("[data-basket-remove]").dispatch("click");
  expect(f.client.removeInformationBasketSource).not.toHaveBeenCalled(); f.confirm(true);
  await vi.waitFor(() => expect(f.client.removeInformationBasketSource).toHaveBeenCalledWith(managedSource.sourceId, 4, "dev"));
  await vi.waitFor(() => expect(f.manager.isBusy()).toBe(false));
  expect(f.onChanged).toHaveBeenCalledWith("resources");
});

test("dirty Skills remain open on declined close and discard only after accepted commit", async () => {
  const f = fixture(); await f.manager.open("skills", { id: managedSkill.skillId });
  f.input("[data-skills-content]", "Unsaved");
  const declined = f.manager.close(); f.confirm(false);
  expect(await declined).toBe(false); expect(f.root.open).toBe(true); expect(f.manager.isDirty()).toBe(true);
  const pending = f.manager.prepareLeave(); f.confirm(true);
  const commit = await pending;
  expect(f.manager.isDirty()).toBe(true); expect(f.root.open).toBe(true);
  expect(commit.canCommit()).toBe(true); expect(commit()).toBe(true);
  expect(f.root.open).toBe(false); expect(f.manager.isDirty()).toBe(false);
});

test("Resource setting drafts and edits made after a clean preparation fence stale leave commits", async () => {
  const f = fixture(); await f.manager.open("resources");
  const clean = await f.manager.prepareLeave();
  const mode = f.find("[data-basket-match-mode]"); mode.value = "strict"; mode.dispatch("change");
  expect(clean.canCommit()).toBe(false); expect(clean()).toBe(false);
  const preparation = f.manager.prepareLeave(); f.confirm(true); const commit = await preparation;
  mode.value = "flexible"; mode.dispatch("change");
  expect(commit.canCommit()).toBe(false); expect(commit()).toBe(false);
  const close = f.manager.close(); f.confirm(false);
  expect(await close).toBe(false); expect(f.manager.isDirty()).toBe(true);
  const accepted = f.manager.close(); f.confirm(true);
  expect(await accepted).toBe(true); expect(f.root.open).toBe(false);
});

test("pending mutations block close, escape and environment preparation", async () => {
  const save = deferredManagement<{ skill: typeof managedSkill }>();
  const f = fixture({ updatePersonalSkill: vi.fn(() => save.promise) });
  await f.manager.open("skills", { id: managedSkill.skillId });
  f.input("[data-skills-content]", "Saving"); f.find("[data-skills-form]").dispatch("submit");
  expect(f.manager.isBusy()).toBe(true); expect(await f.manager.close()).toBe(false);
  expect(await f.manager.prepareLeave()).toBe(false);
  f.root.dispatch("cancel"); await Promise.resolve(); expect(f.root.open).toBe(true);
  save.resolve({ skill: { ...managedSkill, content: "Saving", revision: 3 } });
  await vi.waitFor(() => expect(f.manager.isBusy()).toBe(false));
  expect(await f.manager.close()).toBe(true);
});

test("dialog IDs are scoped beside an existing workspace and nested dialogs close on environment change", async () => {
  const f = fixture(); const existing = f.documentRoot.createElement("input");
  existing.setAttribute("id", "basket-chat-uploads"); f.documentRoot.body.append(existing);
  await f.manager.open("resources", { id: managedSource.sourceId });
  expect(f.find(".basket-detail-dialog").open).toBe(true);
  const ids = f.documentRoot.body.querySelectorAll("[id]").map((node) => node.getAttribute("id"));
  expect(new Set(ids).size).toBe(ids.length);
  expect(f.find("[data-basket-chat-uploads]").getAttribute("id")).not.toBe("basket-chat-uploads");
  const references = f.root.querySelectorAll("[aria-describedby]").flatMap((node) => node.getAttribute("aria-describedby")!.split(" "));
  expect(references.every((id) => ids.includes(id))).toBe(true);
  const detail = f.find(".basket-detail-dialog"); f.setEnvironment("prod");
  expect(detail.open).toBe(false); expect(f.root.open).toBe(false); expect(f.manager.isOpen()).toBe(false);
  await f.manager.open("resources"); expect(f.client.listInformationBasket).toHaveBeenLastCalledWith("prod");
});

test("superseded asynchronous reads and confirmations cannot publish or mutate a new environment", async () => {
  const reading = deferredManagement<{ items: typeof managedSkill[] }>();
  const f = fixture({ listPersonalSkills: vi.fn(() => reading.promise) });
  const opening = f.manager.open("skills"); await Promise.resolve(); await Promise.resolve();
  f.setEnvironment("prod"); reading.resolve({ items: [managedSkill] });
  expect(await opening).toBe(false); expect(f.root.open).toBe(false);
  f.client.listPersonalSkills.mockResolvedValue({ items: [managedSkill] });
  await f.manager.open("skills", { id: managedSkill.skillId });
  f.find("[data-skills-archive]").dispatch("click");
  const oldConfirmation = f.documentRoot.body.querySelector(".confirmation-dialog")!;
  expect(oldConfirmation.open).toBe(true); f.setEnvironment("dev");
  expect(oldConfirmation.open).toBe(false); f.confirm(true); await Promise.resolve();
  expect(f.client.archivePersonalSkill).not.toHaveBeenCalled();
});

test("realtime resources, reconnect and availability use the active existing controller", async () => {
  const f = fixture(); expect(await f.manager.open("unknown")).toBe(false);
  await f.manager.open("resources"); f.client.listInformationBasket.mockClear();
  f.manager.handleRealtime({ type: "workspace_changed", environmentId: "another", resources: ["information-basket"] });
  expect(f.client.listInformationBasket).not.toHaveBeenCalled();
  f.manager.handleRealtime({ type: "workspace_changed", environmentId: "dev", resources: ["information-basket"] });
  await vi.waitFor(() => expect(f.client.listInformationBasket).toHaveBeenCalledWith("dev"));
  await f.manager.reconnect(); expect(f.client.listInformationBasket.mock.calls.length).toBeGreaterThan(1);
  await f.manager.close(); f.client.listInformationBasket.mockClear(); await f.manager.reconnect();
  expect(f.client.listInformationBasket).not.toHaveBeenCalled();
});

test("reopening uses a fresh listener root and nested Escape leaves the manager open", async () => {
  const f = fixture(); await f.manager.open("skills");
  const oldWorkspace = f.find(".skills-workspace-panel");
  expect(await f.manager.close()).toBe(true); await f.manager.open("skills");
  const freshWorkspace = f.find(".skills-workspace-panel");
  expect(freshWorkspace).not.toBe(oldWorkspace);
  f.client.listPersonalSkills.mockClear();
  f.find("[data-skills-refresh]").dispatch("click");
  await vi.waitFor(() => expect(f.client.listPersonalSkills).toHaveBeenCalledTimes(1));
  await f.manager.close(); await f.manager.open("resources");
  f.find("[data-basket-choose]").dispatch("click");
  await vi.waitFor(() => expect(f.find(".basket-picker-dialog").open).toBe(true));
  const event = { key: "Escape", target: f.find(".basket-picker-dialog"), defaultPrevented: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn() };
  for (const handler of f.root.listeners.get("keydown") || []) handler(event);
  await Promise.resolve(); expect(f.root.open).toBe(true); expect(event.preventDefault).not.toHaveBeenCalled();
});
