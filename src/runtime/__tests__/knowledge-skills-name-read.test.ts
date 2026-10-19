import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createKnowledgeSkillsToolModule } from "../capabilities/knowledge-skills/tool-module.js";
import { createRuntimeKnowledgeSkillStore } from "../knowledge-skills/personal-store.js";
import { PERSONAL_SKILL_LIMITS } from "../knowledge-skills/personal-contracts.js";
import { createKnowledgeSkillStore, KNOWLEDGE_SKILL_READ_MAX_ITEMS,
  type KnowledgeSkillStore } from "../knowledge-skills/store.js";

const first = { skillId: "first", name: "סיכום יומי טכנולוגי",
  description: "Daily technology guidance.", content: "FIRST_BODY: keep exact.\n" };
const second = { ...first, skillId: "second", content: "SECOND_BODY: another document." };
const third = { ...first, skillId: "third", name: "Other guidance", content: "THIRD_BODY." };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fixture(source: KnowledgeSkillStore = createKnowledgeSkillStore([first, second, third])) {
  const store = { list: vi.fn(source.list), read: vi.fn(source.read) };
  const tools = createConfiguredToolRegistry(undefined, [createKnowledgeSkillsToolModule(store)]);
  const read = (skillId: string) => tools.execute({ tool: "abot_skills", params: { action: "read_skill", skillId } });
  const readMany = (skillIds: string[]) => tools.execute({ tool: "abot_skills", params: { action: "read_skills", skillIds } });
  return { store, tools, read, readMany };
}

test("a unique full Unicode name returns the existing single-document shape with its canonical ID", async () => {
  const f = fixture(createKnowledgeSkillStore([first]));
  const result = await f.read(first.name);
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output)).toEqual({ skillId: first.skillId, name: first.name, content: first.content });
  expect(result.data).toMatchObject({ itemCount: 1, mutationEvidence: false, skillTitle: first.name });
});

test("a shared name returns every matching document in catalog order", async () => {
  const f = fixture();
  const result = await f.read(first.name);
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output)).toEqual({ skills: [first, second].map(({ skillId, name, content }) =>
    ({ skillId, name, content })) });
  expect(result.data).toMatchObject({ itemCount: 2, mutationEvidence: false });
  expect(f.store.list).toHaveBeenCalledOnce();
});

test("an exact ID wins over a different document bearing that name, without catalog access", async () => {
  const f = fixture(createKnowledgeSkillStore([first, { ...second, name: first.skillId }]));
  const result = await f.read(first.skillId);
  expect(JSON.parse(result.output)).toMatchObject({ skillId: first.skillId, content: first.content });
  expect(result.output).not.toContain(second.content);
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.store.read).toHaveBeenCalledExactlyOnceWith(first.skillId);
});

test("mixed IDs and names deduplicate by canonical ID and preserve first-reference order", async () => {
  const f = fixture();
  const result = await f.readMany([second.skillId, first.name, third.name, first.skillId]);
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output).skills.map(({ skillId }: { skillId: string }) => skillId))
    .toEqual([second.skillId, first.skillId, third.skillId]);
  expect(result.data).toMatchObject({ itemCount: 3 });
  expect(f.store.list).toHaveBeenCalledOnce();
});

test.each(["Other", "other guidance", "סיכום יומי", "missing"])(
  "names are exact and case-sensitive, with no partial or fuzzy resolution: %s", async (name) => {
    const result = await fixture().read(name);
    expect(result).toMatchObject({ ok: false, errorCode: "knowledge_skill_not_found", producedNewInformation: false });
    expect(result.output).not.toContain("BODY");
  },
);

test.each(["read_skill", "read_skills"])("%s rejects a name renamed after catalog discovery without returning partial guidance", async (action) => {
  const f = fixture();
  f.store.read.mockImplementation((id) => {
    if (id === first.skillId) return first;
    if (id === second.skillId) return { ...second, name: "Renamed guidance" };
    return third;
  });
  const result = action === "read_skill" ? await f.read(first.name) : await f.readMany([first.name]);
  expect(result).toMatchObject({ ok: false, errorCode: "knowledge_skill_not_found" });
  expect(result.output).not.toContain("BODY");
});

test("a later name must match an already resolved document before deduplication", async () => {
  const f = fixture(createKnowledgeSkillStore([third]));
  f.store.list.mockReturnValue([{ ...third, name: "Renamed guidance" }]);
  const result = await f.readMany([third.skillId, "Renamed guidance"]);
  expect(result).toMatchObject({ ok: false, errorCode: "knowledge_skill_not_found" });
  expect(result.output).not.toContain(third.content);
});

test("renaming a document does not invalidate an exact ID read", async () => {
  const f = fixture(createKnowledgeSkillStore([third]));
  f.store.read.mockReturnValue({ ...third, name: "Renamed guidance" });
  const result = await f.read(third.skillId);
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output)).toMatchObject({ skillId: third.skillId, name: "Renamed guidance" });
  expect(f.store.list).not.toHaveBeenCalled();
});

test("an unresolved reference fails a mixed read without exposing partial bodies", async () => {
  const result = await fixture().readMany([first.name, "missing"]);
  expect(result).toMatchObject({ ok: false, errorCode: "knowledge_skill_not_found" });
  expect(result.output).not.toContain("BODY");
});

test.each(["read_skill", "read_skills"])("%s rejects name expansion above the document limit", async (action) => {
  const docs = Array.from({ length: KNOWLEDGE_SKILL_READ_MAX_ITEMS + 1 }, (_, i) =>
    ({ ...first, skillId: "match-" + i }));
  const f = fixture(createKnowledgeSkillStore(docs));
  const result = action === "read_skill" ? await f.read(first.name) : await f.readMany([first.name]);
  expect(result).toMatchObject({ ok: false, errorCode: "knowledge_skill_read_limit_exceeded" });
  expect(result.output).not.toContain(first.content);
});

test("the limit counts distinct resolved documents, including later exact IDs", async () => {
  const docs = Array.from({ length: KNOWLEDGE_SKILL_READ_MAX_ITEMS }, (_, i) =>
    ({ ...first, skillId: "match-" + i }));
  const f = fixture(createKnowledgeSkillStore([...docs, third]));
  const allowed = await f.readMany([first.name, docs[0]!.skillId]);
  expect(allowed).toMatchObject({ ok: true, data: { itemCount: KNOWLEDGE_SKILL_READ_MAX_ITEMS } });
  const overflow = await f.readMany([first.name, third.skillId]);
  expect(overflow).toMatchObject({ ok: false, errorCode: "knowledge_skill_read_limit_exceeded" });
  expect(overflow.output).not.toContain("BODY");
});

test.each(["read_skill", "read_skills"])("%s accepts the full personal-name limit through normal invocation", async (action) => {
  const document = { ...first, name: "ש".repeat(PERSONAL_SKILL_LIMITS.name) };
  const f = fixture(createKnowledgeSkillStore([document]));
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: f.tools.listNormalInvocations!(), toolRegistry: f.tools,
    requestId: "skill-name-contract", abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access", nextApprovalId: () => "approval",
  });
  const handle = executor.operations.find(({ operation }) => operation.operationId === action)!.handle;
  const controls = (name: string) => action === "read_skill" ? { skillId: name } : { skillIds: [name] };
  const invalid = executor.prepare({ handle, controls: controls(document.name + "ש") });
  expect(invalid).toMatchObject({ status: "rejected", code: "normal_invocation_input_invalid" });
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.store.list).not.toHaveBeenCalled();
  const prepared = executor.prepare({ handle, controls: controls(document.name) });
  expect(prepared.status).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error("fixture_preparation_rejected");
  const result = await prepared.execute("skill-name-read");
  expect(result).toMatchObject({ status: "executed", result: { ok: true } });
  if (result.status !== "executed") throw new Error("fixture_execution_rejected");
  const body = JSON.parse(result.result.output);
  expect(action === "read_skill" ? body : body.skills[0]).toMatchObject({
    skillId: first.skillId, name: document.name, content: first.content,
  });
});

test("shared system/personal names resolve from the current Store, while updates remain ID-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-name-read-"));
  roots.push(root);
  const store = createRuntimeKnowledgeSkillStore(root, createKnowledgeSkillStore([first]));
  const personal = await store.create({ name: first.name, description: "Personal guidance.", content: second.content });
  const f = fixture(store);
  const result = await f.read(first.name);
  expect(JSON.parse(result.output).skills).toEqual([
    { ...first, source: "system" },
    personal,
  ]);
  await expect(store.update(first.skillId, 1, { content: "Overwrite" })).rejects.toThrow("knowledge_skill_read_only");
  await expect(store.update(first.name, 1, { content: "Overwrite" })).rejects.toThrow("knowledge_skill_not_found");
  await store.update(personal.skillId, 1, { name: "Renamed personal", content: "Replacement" });
  const renamed = await f.read("Renamed personal");
  expect(JSON.parse(renamed.output)).toMatchObject({ skillId: personal.skillId, revision: 2, content: "Replacement" });
  const original = await f.read(first.name);
  expect(JSON.parse(original.output)).toMatchObject({ skillId: first.skillId, source: "system" });
  expect(original.data).toMatchObject({ itemCount: 1 });
});
