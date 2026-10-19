import { PERSONAL_SKILL_LIMITS } from "../../knowledge-skills/personal-contracts.js";
import {
  isKnowledgeSkillId, KNOWLEDGE_SKILL_ID_MAX_LENGTH, KNOWLEDGE_SKILL_READ_MAX_ITEMS,
  type KnowledgeSkillDocument, type KnowledgeSkillMetadata, type KnowledgeSkillStore,
} from "../../knowledge-skills/store.js";

export const KNOWLEDGE_SKILL_READ_REFERENCE_MAX_LENGTH =
  Math.max(KNOWLEDGE_SKILL_ID_MAX_LENGTH, PERSONAL_SKILL_LIMITS.name);

export function isKnowledgeSkillReadReference(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > KNOWLEDGE_SKILL_READ_REFERENCE_MAX_LENGTH) return false;
  return value.trim() === value;
}

function matchesSkillReadReference(skill: KnowledgeSkillDocument, reference: string): boolean {
  if (skill.skillId === reference) return true;
  return skill.name === reference;
}

function exceedsSkillReadLimit(count: number): boolean {
  return count > KNOWLEDGE_SKILL_READ_MAX_ITEMS;
}

type ResolvedSkillRead =
  | Readonly<{ ok: true; skills: readonly KnowledgeSkillDocument[] }>
  | Readonly<{ ok: false; errorCode: string }>;

/** Resolve exact IDs first, then full names, against the same Store used for discovery. */
export function resolveKnowledgeSkillReadTargets(
  store: KnowledgeSkillStore, references: readonly string[],
): ResolvedSkillRead {
  let catalog: readonly KnowledgeSkillMetadata[] | undefined;
  const skills = new Map<string, KnowledgeSkillDocument>();
  for (const reference of references) {
    const exactId = isKnowledgeSkillId(reference) ? store.read(reference) : undefined;
    const matches = exactId
      ? [exactId]
      : (catalog ??= store.list()).filter(({ name }) => name === reference);
    if (matches.length === 0) return { ok: false, errorCode: "knowledge_skill_not_found" };
    for (const { skillId } of matches) {
      const skill = exactId ?? skills.get(skillId) ?? store.read(skillId);
      if (!skill) return { ok: false, errorCode: "knowledge_skill_not_found" };
      if (!matchesSkillReadReference(skill, reference))
        return { ok: false, errorCode: "knowledge_skill_not_found" };
      if (skills.has(skillId)) continue;
      if (exceedsSkillReadLimit(skills.size + 1))
        return { ok: false, errorCode: "knowledge_skill_read_limit_exceeded" };
      skills.set(skillId, skill);
    }
  }
  return { ok: true, skills: [...skills.values()] };
}
