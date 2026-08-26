export type RuntimeSkillCatalog = Readonly<{
  skills: Readonly<Record<string, string>>;
  actionSkills: Readonly<Record<string, readonly string[]>>;
}>;

export type SkillsContextProvider = {
  getActionContext: (action: string) => Promise<string>;
};

const EMPTY_CATALOG: RuntimeSkillCatalog = Object.freeze({
  skills: Object.freeze({}),
  actionSkills: Object.freeze({}),
});

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildActionContext(
  skillNames: readonly string[],
  skills: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [];
  for (const skillName of unique(skillNames)) {
    const content = skills[skillName]?.trim();
    if (!content) {
      continue;
    }
    parts.push(`### SKILL: ${skillName}`, content, "");
  }
  return parts.join("\n").trim();
}

/**
 * Projects plugin-authored action mappings into model context. This layer
 * classifies no capability and carries no tool-specific policy.
 */
export function createSkillsContextProvider(
  catalog: RuntimeSkillCatalog = EMPTY_CATALOG,
): SkillsContextProvider {
  return {
    getActionContext: (action: string) =>
      Promise.resolve(
        buildActionContext(catalog.actionSkills[action] ?? [], catalog.skills),
      ),
  };
}
