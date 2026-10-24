import { describe, expect, test } from "vitest";
import { builtinKnowledgeSkillStore } from "../knowledge-skills/catalog.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";

const sourceDocument = () => ({
  skillId: "reference-one",
  name: "Reference one",
  description: "Metadata describing when this reference is useful.",
  content: "  Exact source text.\n\nSecond paragraph: שלום.\n",
});

describe("core knowledge document store", () => {
  test("LIST exposes metadata while READ preserves exact content for the selected ID", () => {
    const document = sourceDocument();
    const store = createKnowledgeSkillStore([document]);
    expect(store.list()).toEqual([{
      skillId: document.skillId,
      name: document.name,
      description: document.description,
    }]);
    expect(store.list()[0]).not.toHaveProperty("content");
    expect(store.read(document.skillId)).toEqual(document);
    for (const alias of [document.name, document.skillId.toUpperCase(), " " + document.skillId, "../reference-one"])
      expect(store.read(alias)).toBeUndefined();
    expect(store.read("missing-reference")).toBeUndefined();
  });

  test("catalog construction snapshots its input and callers cannot rewrite returned records", () => {
    const original = sourceDocument();
    const expected = { ...original };
    const definitions = [original];
    const store = createKnowledgeSkillStore(definitions);
    original.name = "Changed outside the store";
    original.content = "Changed outside the store";
    definitions.push({ ...original, skillId: "later-reference" });
    expect(store.read(expected.skillId)).toEqual(expected);
    expect(store.read("later-reference")).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(Reflect.set(store.list()[0]!, "name", "Rewritten metadata")).toBe(false);
    expect(Reflect.set(store.read(expected.skillId)!, "content", "Rewritten body")).toBe(false);
    expect(store.read(expected.skillId)).toEqual(expected);
    expect(store.list()[0]?.name).toBe(expected.name);
  });

  test("duplicate identities fail catalog construction instead of silently selecting one document", () => {
    const document = sourceDocument();
    expect(() => createKnowledgeSkillStore([
      document,
      { ...document, name: "Conflicting document", content: "Different instructions." },
    ])).toThrow("knowledge_skill_id_duplicate");
  });

  test("the packaged catalog contains the approved read-only references", () => {
    const metadata = builtinKnowledgeSkillStore.list();
    expect(metadata.map(({ skillId, name }) => ({ skillId, name }))).toEqual([
      { skillId: "abot-studio", name: "ABot Studio" },
      { skillId: "computer-use", name: "Computer Use" },
      { skillId: "skill-creator", name: "Skill Creator" },
      { skillId: "technical-work", name: "Technical Work" },
      { skillId: "what-can-i-do", name: "What Can I Do?" },
    ]);
    for (const entry of metadata) {
      expect(entry).not.toHaveProperty("content");
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(builtinKnowledgeSkillStore.read(entry.skillId)).toMatchObject(entry);
      expect(builtinKnowledgeSkillStore.read(entry.skillId)!.content.trim().length).toBeGreaterThan(0);
    }
  });
});
