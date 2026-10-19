import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createRuntimeKnowledgeSkillStore } from "../knowledge-skills/personal-store.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import { PERSONAL_SKILL_LIMITS } from "../knowledge-skills/personal-contracts.js";
import { projectAvailableSkills } from "../knowledge-skills/available-skills.js";
import { projectAvailableTools } from "../capabilities/tool-availability.js";
import { createDefaultToolRegistry } from "../default-environment-adapters.js";

const roots: string[] = [];
const input = { name: "My review", description: "Review Git changes for this user.", content: "  # Review\n\nKeep exact Unicode שלום.\n" };
const packaged = { skillId: "system", name: "System", description: "Packaged guidance.", content: "System original." };
const system = createKnowledgeSkillStore([packaged]);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "personal-skills-"));
  roots.push(root);
  return { root, store: createRuntimeKnowledgeSkillStore(root, system), file: join(root, "skills/personal.json") };
}

test("personal documents survive a new Store, share one environment and remain separate from prod", async () => {
  const f = await setup();
  const skill = await f.store.create(input);
  expect(skill).toMatchObject({ ...input, source: "personal", revision: 1, skillId: expect.stringMatching(/^personal-/) });
  const reloaded = createRuntimeKnowledgeSkillStore(f.root, system);
  expect(reloaded.read(skill.skillId)).toEqual(skill);
  expect(reloaded.list()).toEqual([
    { skillId: packaged.skillId, name: packaged.name, description: packaged.description, source: "system" },
    { skillId: skill.skillId, name: input.name, description: input.description, source: "personal" },
  ]);
  expect(JSON.stringify(reloaded.list())).not.toContain(input.content);
  const prod = createRuntimeKnowledgeSkillStore(join(f.root, "prod"), system);
  expect(prod.read(skill.skillId)).toBeUndefined();
  expect(prod.list()).toHaveLength(1);
  expect(reloaded.read(packaged.skillId)).toEqual({ ...packaged, source: "system" });
});

test("updates preserve omitted metadata, increment once and reject stale edits without changes", async () => {
  const f = await setup();
  const skill = await f.store.create(input);
  const update = await f.store.update(skill.skillId, skill.revision, { content: "Replacement." });
  expect(update).toEqual({ ...skill, content: "Replacement.", revision: 2 });
  const before = await readFile(f.file, "utf8");
  await expect(f.store.update(skill.skillId, 1, { content: "Stale." })).rejects.toThrow("knowledge_skill_revision_conflict");
  await expect(f.store.update("personal-missing", 1, { content: "Missing." })).rejects.toThrow("knowledge_skill_not_found");
  expect(await readFile(f.file, "utf8")).toBe(before);
  const renamed = await f.store.update(skill.skillId, 2, { name: "New name", description: "New applicability.", content: "New." });
  expect(renamed).toMatchObject({ name: "New name", description: "New applicability.", revision: 3 });
});

test("system edits are rejected before personal storage is created", async () => {
  const f = await setup();
  await expect(f.store.update(packaged.skillId, 1, { content: "Overwrite." })).rejects.toThrow("knowledge_skill_read_only");
  await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.store.read(packaged.skillId)).toEqual({ ...packaged, source: "system" });
});

test("independent Store instances serialize creates and reject one of two competing edits", async () => {
  const f = await setup();
  const second = createRuntimeKnowledgeSkillStore(f.root, system);
  const [one, two] = await Promise.all([f.store.create(input), second.create({ ...input, name: "Second" })]);
  expect(f.store.list()).toHaveLength(3);
  expect(second.read(one.skillId)).toEqual(one);
  expect(f.store.read(two.skillId)).toEqual(two);
  const results = await Promise.allSettled([
    f.store.update(one.skillId, 1, { content: "First edit." }),
    second.update(one.skillId, 1, { content: "Second edit." }),
  ]);
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(results.find(({ status }) => status === "rejected")).toMatchObject({
    reason: { message: "knowledge_skill_revision_conflict" },
  });
  expect(f.store.read(one.skillId)?.revision).toBe(2);
  expect(f.store.read(two.skillId)).toEqual(two);
});

test.each([
  { name: "" }, { description: " " }, { content: " " },
  { name: "n".repeat(PERSONAL_SKILL_LIMITS.name + 1) },
  { content: "א".repeat(PERSONAL_SKILL_LIMITS.contentBytes / 2 + 1) },
])("invalid input leaves persisted data unchanged: $name", async (patch) => {
  const f = await setup();
  await f.store.create(input);
  const before = await readFile(f.file, "utf8");
  await expect(f.store.create({ ...input, ...patch })).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(before);
});

test("corrupt storage omits optional discovery, fails writes without overwriting and keeps system READ working", async () => {
  const f = await setup();
  await f.store.create(input);
  await writeFile(f.file, "{broken", "utf8");
  const tools = createDefaultToolRegistry(undefined, undefined, undefined, f.store);
  expect(projectAvailableSkills(f.store, projectAvailableTools(tools.listNormalInvocations!()))).toEqual([]);
  const result = await tools.execute({ tool: "abot_skills", params: { action: "list_skills" } });
  expect(result).toMatchObject({ ok: false, errorCode: "knowledge_skill_storage_invalid", data: { mutationEvidence: false } });
  await expect(f.store.create(input)).rejects.toThrow("knowledge_skill_storage_invalid");
  expect(await readFile(f.file, "utf8")).toBe("{broken");
  expect(f.store.read(packaged.skillId)?.content).toBe(packaged.content);
});
