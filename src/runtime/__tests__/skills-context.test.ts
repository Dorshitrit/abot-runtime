import { describe, expect, test } from "vitest";

import {
  createSkillsContextProvider,
  type RuntimeSkillCatalog,
} from "../context/skills-context.js";

const catalog: RuntimeSkillCatalog = {
  skills: {
    lookup_guidance: "# Lookup\n\nUse the selected lookup capability.",
    mutation_guidance: "# Mutation\n\nUse the selected mutation capability.",
    shared_guidance: "# Shared\n\nApply this plugin-owned shared rule.",
  },
  actionSkills: {
    lookup_capability: ["lookup_guidance", "shared_guidance"],
    mutation_capability: ["mutation_guidance", "shared_guidance"],
  },
};

describe("plugin skills context", () => {
  test("loads full content only from the selected action mapping", async () => {
    const provider = createSkillsContextProvider(catalog);
    const before = structuredClone(catalog);
    const context = await provider.getActionContext("lookup_capability");

    expect(context).toContain(catalog.skills.lookup_guidance);
    expect(context).toContain(catalog.skills.shared_guidance);
    expect(context.indexOf(catalog.skills.lookup_guidance!)).toBeLessThan(
      context.indexOf(catalog.skills.shared_guidance!),
    );
    expect(context).not.toContain(catalog.skills.mutation_guidance);
    for (const internalId of Object.keys(catalog.skills)) {
      expect(context).not.toContain(internalId);
    }
    expect(catalog).toEqual(before);
    await expect(provider.getActionContext("unknown_capability")).resolves.toBe(
      "",
    );
  });

  test("deduplicates shared skills without applying hidden role policy", async () => {
    const provider = createSkillsContextProvider({
      skills: catalog.skills,
      actionSkills: {
        lookup_capability: ["shared_guidance", "shared_guidance"],
      },
    });

    const context = await provider.getActionContext("lookup_capability");
    expect(context.split(catalog.skills.shared_guidance!)).toHaveLength(2);
    expect(context).not.toContain("shared_guidance");
  });

  test("preserves instruction bytes and skips only missing or empty documents", async () => {
    const body = "# Tool instructions\n\nKeep  internal spacing.\n\n- Use `name: value` literally.\n";
    const provider = createSkillsContextProvider({
      skills: { internal_document: body, empty_document: " \n\t" },
      actionSkills: {
        selected: ["missing_document", "internal_document", "empty_document"],
        empty: ["missing_document", "empty_document"],
      },
    });

    expect(await provider.getActionContext("selected")).toContain(body.trim());
    expect(await provider.getActionContext("empty")).toBe("");
  });

  test("defaults to an empty plugin catalog", async () => {
    const provider = createSkillsContextProvider();

    await expect(provider.getActionContext("anything")).resolves.toBe("");
  });
});
