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

    await expect(
      provider.getActionContext("lookup_capability"),
    ).resolves.toContain("Use the selected lookup capability.");
    await expect(
      provider.getActionContext("lookup_capability"),
    ).resolves.not.toContain("Use the selected mutation capability.");
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
    expect(context.match(/### SKILL: shared_guidance/g)).toHaveLength(1);
  });

  test("defaults to an empty plugin catalog", async () => {
    const provider = createSkillsContextProvider();

    await expect(provider.getActionContext("anything")).resolves.toBe("");
  });
});
