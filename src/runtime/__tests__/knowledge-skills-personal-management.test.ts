import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRuntimeKnowledgeSkillStore } from "../knowledge-skills/personal-store.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import { canManageKnowledgeSkills, PERSONAL_SKILL_LIMITS } from "../knowledge-skills/personal-contracts.js";
import { resolveKnowledgeSkillReadTargets } from "../capabilities/knowledge-skills/read-targets.js";
import { projectAvailableSkills } from "../knowledge-skills/available-skills.js";
import { projectAvailableTools } from "../capabilities/tool-availability.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createKnowledgeSkillsToolModule } from "../capabilities/knowledge-skills/tool-module.js";

const roots: string[] = [];
const input = { name: "My review", description: "Review changes for this user.", content: "  # Review\n\nKeep exact Unicode שלום.\n" };
const packaged = { skillId: "system", name: "System", description: "Packaged guidance.", content: "System original." };
const system = createKnowledgeSkillStore([packaged]);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "personal-skill-management-"));
  roots.push(root);
  const store = createRuntimeKnowledgeSkillStore(root, system);
  return { root, store, management: store.personalSkills, file: join(root, "skills/personal.json") };
}

test("management creation generates active personal metadata and is immediately available to the model and after restart", async () => {
  const f = await setup();
  const created = await f.management.create({ ...input, name: "  My review  ", description: "  Review changes for this user.  " });
  expect(created).toEqual({ ...input, skillId: expect.stringMatching(/^personal-[0-9a-f-]{36}$/),
    source: "personal", revision: 1, archived: false });
  const { archived: _archived, ...document } = created;
  expect(f.store.read(created.skillId)).toEqual(document);
  expect(resolveKnowledgeSkillReadTargets(f.store, [created.name])).toEqual({ ok: true, skills: [document] });
  expect(f.store.list()).toContainEqual({ skillId: created.skillId, name: input.name,
    description: input.description, source: "personal" });
  expect(await f.management.get(created.skillId)).toEqual(created);
  const { content: _content, ...summary } = created;
  expect(await f.management.list()).toEqual([summary]);
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({ schemaVersion: 2, skills: [created] });
  const reloaded = createRuntimeKnowledgeSkillStore(f.root, system);
  expect(await reloaded.personalSkills.get(created.skillId)).toEqual(created);
  expect(reloaded.read(created.skillId)).toEqual(document);
});

test("management and model creation share one lock and allow distinct documents with the same name", async () => {
  const f = await setup();
  const second = createRuntimeKnowledgeSkillStore(f.root, system);
  const [manual, model] = await Promise.all([
    f.management.create(input),
    second.create({ ...input, content: "Created by the model." }),
  ]);
  expect(manual.skillId).not.toBe(model.skillId);
  expect(model).not.toHaveProperty("archived");
  expect(await f.management.list()).toHaveLength(2);
  expect(f.store.read(manual.skillId)?.content).toBe(input.content);
  expect(f.store.read(model.skillId)?.content).toBe("Created by the model.");
  expect(JSON.parse(await readFile(f.file, "utf8")).skills).toHaveLength(2);
});

test.each([
  { ...input, name: " " },
  { ...input, description: "x".repeat(PERSONAL_SKILL_LIMITS.description + 1) },
  { ...input, content: "א".repeat(PERSONAL_SKILL_LIMITS.contentBytes / 2 + 1) },
])("invalid management creation preserves the existing store (%#)", async (invalid) => {
  const f = await setup();
  await f.management.create(input);
  const before = await readFile(f.file, "utf8");
  await expect(f.management.create(invalid)).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(before);
  expect(await f.management.list()).toHaveLength(1);
});

test("management lists personal metadata only and content editing preserves identity and model document shape", async () => {
  const f = await setup();
  const created = await f.store.create(input);
  expect(created).not.toHaveProperty("archived");
  expect(await f.management.list()).toEqual([{
    skillId: created.skillId, name: input.name, description: input.description,
    source: "personal", revision: 1, archived: false,
  }]);
  expect(await f.management.get(created.skillId)).toEqual({ ...created, archived: false });
  const content = "  # Edited\n\nשינוי התוכן בלבד.\n";
  const updated = await f.management.updateContent(created.skillId, 1, content);
  expect(updated).toEqual({ ...created, content, revision: 2, archived: false });
  expect(f.store.read(created.skillId)).toEqual({ ...created, content, revision: 2 });
  expect(f.store.list().find(({ skillId }) => skillId === created.skillId)).toEqual({
    skillId: created.skillId, name: input.name, description: input.description, source: "personal",
  });
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({ schemaVersion: 2, skills: [updated] });
});

test("archive survives restart, removes ID and name lookup, and restore preserves content with a new revision", async () => {
  const f = await setup();
  const created = await f.store.create(input);
  const captured = f.store.read(created.skillId);
  const archived = await f.management.archive(created.skillId, 1);
  expect(archived).toEqual({ ...created, revision: 2, archived: true });
  const reloaded = createRuntimeKnowledgeSkillStore(f.root, system);
  expect(reloaded.read(created.skillId)).toBeUndefined();
  expect(reloaded.list()).toEqual([{
    skillId: packaged.skillId, name: packaged.name, description: packaged.description, source: "system",
  }]);
  for (const reference of [created.skillId, created.name]) {
    expect(resolveKnowledgeSkillReadTargets(reloaded, [reference])).toEqual({
      ok: false, errorCode: "knowledge_skill_not_found",
    });
  }
  const registry = createConfiguredToolRegistry(undefined, [createKnowledgeSkillsToolModule(reloaded)]);
  expect(projectAvailableSkills(reloaded, projectAvailableTools(registry.listNormalInvocations!())))
    .toEqual([{ skillId: packaged.skillId, name: packaged.name, description: packaged.description }]);
  expect(await reloaded.personalSkills.get(created.skillId)).toEqual(archived);
  expect((await reloaded.personalSkills.list())[0]).toMatchObject({ skillId: created.skillId, archived: true });
  const restored = await reloaded.personalSkills.restore(created.skillId, 2);
  expect(restored).toEqual({ ...created, revision: 3, archived: false });
  expect(f.store.read(created.skillId)).toEqual({ ...created, revision: 3 });
  expect(resolveKnowledgeSkillReadTargets(f.store, [created.name])).toEqual({
    ok: true, skills: [{ ...created, revision: 3 }],
  });
  expect(captured).toEqual(created);
});

test("a shared name resolves only its active personal documents", async () => {
  const f = await setup();
  const first = await f.store.create(input);
  const second = await f.store.create({ ...input, content: "Another active document." });
  await f.management.archive(first.skillId, 1);
  expect(resolveKnowledgeSkillReadTargets(f.store, [input.name])).toEqual({ ok: true, skills: [second] });
  expect(await f.management.list()).toHaveLength(2);
});

test("archived content is view-only for both management and the model until restored", async () => {
  const f = await setup();
  const created = await f.store.create(input);
  await f.management.archive(created.skillId, 1);
  const before = await readFile(f.file, "utf8");
  await expect(f.management.updateContent(created.skillId, 2, "Changed."))
    .rejects.toThrow("knowledge_skill_archived");
  await expect(f.store.update(created.skillId, 2, { name: "Renamed", content: "Changed." }))
    .rejects.toThrow("knowledge_skill_archived");
  await expect(f.management.restore(created.skillId, 1)).rejects.toThrow("knowledge_skill_revision_conflict");
  expect(await readFile(f.file, "utf8")).toBe(before);
  await f.management.restore(created.skillId, 2);
  const updated = await f.store.update(created.skillId, 3, { name: "Renamed", content: "Changed." });
  expect(updated).toMatchObject({ name: "Renamed", content: "Changed.", revision: 4 });
  expect(updated).not.toHaveProperty("archived");
});

test("management rejects system access before personal storage exists and reports absent personal records", async () => {
  const f = await setup();
  expect(await f.management.list()).toEqual([]);
  await expect(f.management.get(packaged.skillId)).rejects.toThrow("knowledge_skill_read_only");
  await expect(f.management.updateContent(packaged.skillId, 1, "Changed."))
    .rejects.toThrow("knowledge_skill_read_only");
  await expect(f.management.archive(packaged.skillId, 1)).rejects.toThrow("knowledge_skill_read_only");
  await expect(f.management.restore(packaged.skillId, 1)).rejects.toThrow("knowledge_skill_read_only");
  await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.management.get("personal-missing")).toBeUndefined();
  await expect(f.management.archive("personal-missing", 1)).rejects.toThrow("knowledge_skill_not_found");
  await expect(f.management.get(" malformed ")).rejects.toThrow("knowledge_skill_id_invalid");
});

test("v1 loads as active without rewriting; the next accepted write persists v2", async () => {
  const f = await setup();
  const created = await f.store.create(input);
  const legacy = JSON.stringify({ schemaVersion: 1, skills: [created] }, null, 2);
  await writeFile(f.file, legacy, "utf8");
  const before = await stat(f.file);
  const reloaded = createRuntimeKnowledgeSkillStore(f.root, system);
  expect(reloaded.read(created.skillId)).toEqual(created);
  expect(await reloaded.personalSkills.get(created.skillId)).toEqual({ ...created, archived: false });
  expect(await reloaded.personalSkills.list()).toHaveLength(1);
  expect(await readFile(f.file, "utf8")).toBe(legacy);
  expect((await stat(f.file)).mtimeMs).toBe(before.mtimeMs);
  await reloaded.personalSkills.archive(created.skillId, 1);
  expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual({
    schemaVersion: 2, skills: [{ ...created, revision: 2, archived: true }],
  });
});

test.each([undefined, "true", null, 0])("v2 invalid archive state %s is rejected without replacing the snapshot", async (archived) => {
  const f = await setup();
  const created = await f.store.create(input);
  const invalid = JSON.stringify({ schemaVersion: 2, skills: [{ ...created, archived }] });
  await writeFile(f.file, invalid, "utf8");
  await expect(f.management.list()).rejects.toThrow("knowledge_skill_storage_invalid");
  await expect(f.management.restore(created.skillId, 1)).rejects.toThrow("knowledge_skill_storage_invalid");
  expect(await readFile(f.file, "utf8")).toBe(invalid);
  expect(f.store.read(packaged.skillId)?.content).toBe(packaged.content);
});

test("model edit and management archive share one revision lock across Store instances", async () => {
  const f = await setup();
  const created = await f.store.create(input);
  const second = createRuntimeKnowledgeSkillStore(f.root, system);
  const results = await Promise.allSettled([
    f.store.update(created.skillId, 1, { content: "Model edit." }),
    second.personalSkills.archive(created.skillId, 1),
  ]);
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(results.find(({ status }) => status === "rejected")).toMatchObject({
    reason: { message: "knowledge_skill_revision_conflict" },
  });
  const current = await f.management.get(created.skillId);
  expect(current?.revision).toBe(2);
  if (current?.archived) {
    expect(current.content).toBe(input.content);
    expect(f.store.read(created.skillId)).toBeUndefined();
    return;
  }
  expect(f.store.read(created.skillId)?.content).toBe("Model edit.");
});

test.each([" ", "א".repeat(PERSONAL_SKILL_LIMITS.contentBytes / 2 + 1)])("invalid management content is rejected before persistence", async (content) => {
  const f = await setup();
  const created = await f.store.create(input);
  const before = await readFile(f.file, "utf8");
  await expect(f.management.updateContent(created.skillId, 1, content)).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(before);
});

test("management preserves the revision limit and stale edits never mutate content", async () => {
  const f = await setup();
  const created = await f.store.create(input);
  await f.management.updateContent(created.skillId, 1, "Current content.");
  const before = await readFile(f.file, "utf8");
  await expect(f.management.updateContent(created.skillId, 1, "Stale."))
    .rejects.toThrow("knowledge_skill_revision_conflict");
  await expect(f.management.archive(created.skillId, 1)).rejects.toThrow("knowledge_skill_revision_conflict");
  expect(await readFile(f.file, "utf8")).toBe(before);
  const limit = JSON.stringify({ schemaVersion: 2,
    skills: [{ ...created, revision: PERSONAL_SKILL_LIMITS.revision, archived: false }] });
  await writeFile(f.file, limit, "utf8");
  await expect(f.management.archive(created.skillId, PERSONAL_SKILL_LIMITS.revision))
    .rejects.toThrow("knowledge_skill_revision_limit");
  expect(await readFile(f.file, "utf8")).toBe(limit);
});

test("the management guard accepts complete host services without exposing a catalog-only Store", async () => {
  const f = await setup();
  expect(canManageKnowledgeSkills(f.store)).toBe(true);
  expect(canManageKnowledgeSkills(system)).toBe(false);
  expect(canManageKnowledgeSkills({ ...f.store, personalSkills: {} } as typeof f.store)).toBe(false);
  const { create: _create, ...withoutCreate } = f.management;
  expect(canManageKnowledgeSkills({ ...f.store, personalSkills: withoutCreate } as typeof f.store)).toBe(false);
});
