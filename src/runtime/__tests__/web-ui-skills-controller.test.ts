import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createSkillsController } from "../../web-ui/app/controllers/skills-controller.js";
// @ts-expect-error Browser-only module.
import { createSkillRequests } from "../../web-ui/app/services/runtime-web-client/skills.js";
// @ts-expect-error Browser-only module.
import { prepareEnvironmentWorkspaceChanges } from "../../web-ui/app/controllers/environment-workspace-preparation.js";

const skill = { skillId: "personal/one", name: "My guide", description: "Team conventions",
  source: "personal", revision: 2, archived: false, content: "Existing guidance" };
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(overrides = {}) {
  let environment = "dev";
  const client = {
    supportsSkills: () => true,
    createPersonalSkill: vi.fn(async (input: { name: string; description: string; content: string }) => ({ skill: { ...skill, ...input, skillId: "personal-created", revision: 1 } })),
    listPersonalSkills: vi.fn(async () => ({ items: [skill] })),
    readPersonalSkill: vi.fn(async () => ({ skill: { ...skill } })),
    updatePersonalSkill: vi.fn(async (_id: string, content: string) => ({ skill: { ...skill, revision: 3, content } })),
    archivePersonalSkill: vi.fn(async () => ({ skill: { ...skill, archived: true, revision: 3 } })),
    restorePersonalSkill: vi.fn(async () => ({ skill: { ...skill, revision: 3 } })),
    ...overrides,
  };
  const confirmDiscard = vi.fn(() => false);
  const controller = createSkillsController({ client, getEnvironmentId: () => environment, render: vi.fn(), confirmDiscard });
  return { client, controller, confirmDiscard, setEnvironment(value: string) { environment = value; controller.environmentChanged(); } };
}

 test("client binds IDs, environment and revisions, and refuses bridge transport", async () => {
  let backend = "runtime";
  const requestApi = vi.fn(async () => ({ ok: true }));
  const client = createSkillRequests({ requestApi, getEnvironmentId: () => "dev one", getConfig: () => ({ backend }) });
  await client.createPersonalSkill({ name: "N", description: "D", content: "C", skillId: "ignored" });
  await client.listPersonalSkills();
  await client.readPersonalSkill("personal/a");
  await client.updatePersonalSkill("personal/a", "new", 2);
  await client.archivePersonalSkill("personal/a", 3);
  await client.restorePersonalSkill("personal/a", 4);
  expect(requestApi.mock.calls).toEqual([
    ["/runtime/skills?environment=dev%20one", { method: "POST", body: JSON.stringify({ name: "N", description: "D", content: "C" }) }],
    ["/runtime/skills?environment=dev%20one", undefined],
    ["/runtime/skills/personal%2Fa?environment=dev%20one", undefined],
    ["/runtime/skills/personal%2Fa?environment=dev%20one", { method: "PATCH", body: JSON.stringify({ content: "new", expectedRevision: 2 }) }],
    ["/runtime/skills/personal%2Fa/archive?environment=dev%20one", { method: "POST", body: JSON.stringify({ expectedRevision: 3 }) }],
    ["/runtime/skills/personal%2Fa/restore?environment=dev%20one", { method: "POST", body: JSON.stringify({ expectedRevision: 4 }) }],
  ]);
  backend = "bridge";
  expect(() => client.listPersonalSkills()).toThrow("local Runtime");
  expect(requestApi).toHaveBeenCalledTimes(6);
});

test("save edits content only and adopts the canonical revision", async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.select(skill.skillId);
  f.controller.setDraft("Updated guidance");
  expect(await f.controller.save()).toBe(true);
  expect(f.client.updatePersonalSkill).toHaveBeenCalledExactlyOnceWith(skill.skillId, "Updated guidance", 2, "dev");
  expect(f.controller.snapshot()).toMatchObject({ skill: { revision: 3, name: skill.name }, draft: "Updated guidance", dirty: false });
  expect(f.client.readPersonalSkill).toHaveBeenCalledOnce();
});

test("revision conflicts retain the exact draft and selected revision", async () => {
  const f = fixture({ updatePersonalSkill: vi.fn(async () => { throw Object.assign(new Error("conflict"), { code: "knowledge_skill_revision_conflict" }); }) });
  await f.controller.refresh(); await f.controller.select(skill.skillId); f.controller.setDraft("Keep this edit");
  expect(await f.controller.save()).toBe(false);
  expect(f.controller.snapshot()).toMatchObject({ draft: "Keep this edit", dirty: true, skill: { revision: 2 }, mutation: "" });
  expect(f.controller.snapshot().error).toContain("changed elsewhere");
});

test("archived records are read-only and restore uses the observed revision", async () => {
  const f = fixture({ readPersonalSkill: vi.fn(async () => ({ skill: { ...skill, archived: true } })) });
  await f.controller.refresh(); await f.controller.select(skill.skillId);
  f.controller.setDraft("Must not change");
  expect(f.controller.snapshot().draft).toBe(skill.content);
  expect(await f.controller.save()).toBe(false);
  expect(await f.controller.archive()).toBe(false);
  expect(await f.controller.restore()).toBe(true);
  expect(f.client.restorePersonalSkill).toHaveBeenCalledExactlyOnceWith(skill.skillId, 2, "dev");
  expect(f.client.updatePersonalSkill).not.toHaveBeenCalled();
});

test("core records never enter the personal list or editor", async () => {
  const f = fixture({ listPersonalSkills: vi.fn(async () => ({ items: [{ ...skill, source: "system" }] })) });
  await f.controller.refresh();
  expect(f.controller.snapshot().items).toEqual([]);
  expect(await f.controller.select(skill.skillId)).toBe(false);
  expect(f.client.readPersonalSkill).not.toHaveBeenCalled();
});

test("late reads cannot fill another environment, even after dev-prod-dev", async () => {
  const pending = deferred<{ skill: typeof skill }>();
  const f = fixture({ readPersonalSkill: vi.fn(() => pending.promise) });
  await f.controller.refresh(); const reading = f.controller.select(skill.skillId);
  f.setEnvironment("prod"); f.setEnvironment("dev");
  pending.resolve({ skill }); await reading;
  expect(f.controller.snapshot()).toMatchObject({ skill: null, draft: "", reading: false });
});

test("late mutation results cannot overwrite a new environment", async () => {
  const pending = deferred<{ skill: typeof skill }>();
  const f = fixture({ updatePersonalSkill: vi.fn(() => pending.promise) });
  await f.controller.refresh(); await f.controller.select(skill.skillId); f.controller.setDraft("Changed");
  const saving = f.controller.save();
  expect(await f.controller.prepareLeave()).toBe(false);
  f.setEnvironment("prod"); pending.resolve({ skill: { ...skill, content: "Changed" } });
  expect(await saving).toBe(false);
  expect(f.controller.snapshot()).toMatchObject({ skill: null, draft: "", message: "", mutation: "" });
});

test("workspace and environment guards keep drafts until the full transition commits", async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.select(skill.skillId); f.controller.setDraft("Unsaved");
  const schedules = { prepareEnvironmentChange: vi.fn(() => true) };
  const config = { prepareDiscardChanges: vi.fn(() => true) };
  const skills = { prepareEnvironmentChange: f.controller.prepareLeave };
  expect(await prepareEnvironmentWorkspaceChanges(schedules, config, skills)).toBeNull();
  expect(f.controller.snapshot().draft).toBe("Unsaved");
  f.confirmDiscard.mockReturnValue(true);
  const prepared = await prepareEnvironmentWorkspaceChanges(schedules, config, skills);
  expect(f.controller.snapshot().draft).toBe("Unsaved");
  expect(prepared.canCommit()).toBe(true);
  f.controller.setDraft("Newer unsaved");
  expect(prepared.canCommit()).toBe(false);
  const current = await prepareEnvironmentWorkspaceChanges(schedules, config, skills); current();
  expect(f.controller.snapshot().draft).toBe(skill.content);
  expect(f.controller.isDirty()).toBe(false);
});

test("selecting another Skill or filter respects the unsaved-change guard", async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.select(skill.skillId); f.controller.setDraft("Unsaved");
  expect(await f.controller.setArchived(true)).toBe(false);
  expect(f.controller.snapshot()).toMatchObject({ archived: false, draft: "Unsaved" });
  f.confirmDiscard.mockReturnValue(true);
  expect(await f.controller.setArchived(true)).toBe(true);
  expect(f.controller.snapshot()).toMatchObject({ archived: true, skill: null });
});

async function fillCreation(controller: ReturnType<typeof createSkillsController>) {
  expect(await controller.beginCreate()).toBe(true);
  controller.setCreationField("name", "New personal guide");
  controller.setCreationField("description", "How to work together");
  controller.setDraft("Follow the agreed process.");
}

test("creation sends only editable fields and selects the canonical new Skill", async () => {
  const f = fixture(); await fillCreation(f.controller);
  expect(await f.controller.save()).toBe(true);
  expect(f.client.createPersonalSkill).toHaveBeenCalledExactlyOnceWith({ name: "New personal guide", description: "How to work together", content: "Follow the agreed process." }, "dev");
  expect(f.controller.snapshot()).toMatchObject({ creating: false, archived: false, dirty: false,
    skill: { skillId: "personal-created", revision: 1, name: "New personal guide" } });
});

test.each(["name", "description", "content"])("a new %s draft is protected by cancellation and navigation", async (field) => {
  const f = fixture(); await f.controller.beginCreate();
  if (field === "content") f.controller.setDraft("Unsaved content");
  else f.controller.setCreationField(field, "Unsaved metadata");
  expect(f.controller.isDirty()).toBe(true);
  expect(await f.controller.prepareLeave()).toBe(false);
  expect(await f.controller.cancelCreate()).toBe(false);
  expect(await f.controller.beginCreate()).toBe(false);
  f.confirmDiscard.mockReturnValue(true);
  expect(await f.controller.cancelCreate()).toBe(true);
  expect(f.controller.snapshot()).toMatchObject({ creating: false, name: "", description: "", draft: "", dirty: false });
});

test("creation failure preserves every field and permits retry", async () => {
  const f = fixture({ createPersonalSkill: vi.fn(async () => { throw new Error("Storage unavailable"); }) });
  await fillCreation(f.controller);
  expect(await f.controller.save()).toBe(false);
  expect(f.controller.snapshot()).toMatchObject({ creating: true, name: "New personal guide", description: "How to work together",
    draft: "Follow the agreed process.", dirty: true, mutation: "", error: "Storage unavailable" });
});

test("pending creation blocks leaving and a late result cannot repopulate a changed environment", async () => {
  const pending = deferred<{ skill: typeof skill }>();
  const f = fixture({ createPersonalSkill: vi.fn(() => pending.promise) });
  await fillCreation(f.controller); const saving = f.controller.save();
  expect(await f.controller.prepareLeave()).toBe(false);
  expect(await f.controller.cancelCreate()).toBe(false);
  expect(await f.controller.beginCreate()).toBe(false);
  f.setEnvironment("prod"); f.setEnvironment("dev"); pending.resolve({ skill });
  expect(await saving).toBe(false);
  expect(f.controller.snapshot()).toMatchObject({ skill: null, creating: false, name: "", description: "", draft: "", message: "" });
});

test("creation validates metadata and UTF-8 content bounds before transport", async () => {
  const f = fixture(); await f.controller.beginCreate();
  expect(await f.controller.save()).toBe(false);
  await fillCreation(f.controller);
  f.controller.setCreationField("name", "n".repeat(161));
  expect(await f.controller.save()).toBe(false);
  f.controller.setCreationField("name", "Name"); f.controller.setCreationField("description", "d".repeat(513));
  expect(await f.controller.save()).toBe(false);
  f.controller.setCreationField("description", "Description"); f.controller.setDraft("א".repeat(32769));
  expect(await f.controller.save()).toBe(false);
  expect(f.controller.snapshot().error).toContain("64 KiB");
  expect(f.client.createPersonalSkill).not.toHaveBeenCalled();
});
