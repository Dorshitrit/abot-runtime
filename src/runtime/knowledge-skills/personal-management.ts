import { randomUUID } from "node:crypto";
import { isKnowledgeSkillId, type KnowledgeSkillStore } from "./store.js";
import { isPersonalSkillRevision, validatePersonalSkillInput } from "./personal-documents.js";
import type { createPersonalSkillRepository } from "./personal-repository.js";
import {
  KnowledgeSkillError, PERSONAL_SKILL_LIMITS,
  type PersonalSkillChanges, type PersonalSkillInput,
  type PersonalSkillManagementService, type PersonalSkillRecord,
} from "./personal-contracts.js";

/** Personal writes share one locked revision boundary across model and management callers. */
export function createPersonalSkillManagement(
  repository: ReturnType<typeof createPersonalSkillRepository>,
  system: KnowledgeSkillStore,
) {
  function assertPersonalTarget(skillId: string): void {
    if (!isKnowledgeSkillId(skillId)) throw new KnowledgeSkillError("knowledge_skill_id_invalid");
    if (system.read(skillId)) throw new KnowledgeSkillError("knowledge_skill_read_only");
  }

  async function mutatePersonalSkill(
    skillId: string,
    expectedRevision: number,
    change: (previous: PersonalSkillRecord) => PersonalSkillRecord,
  ): Promise<PersonalSkillRecord> {
    assertPersonalTarget(skillId);
    if (!isPersonalSkillRevision(expectedRevision)) throw new KnowledgeSkillError("knowledge_skill_revision_conflict");
    let updated: PersonalSkillRecord | undefined;
    await repository.update((documents) => {
      const previous = documents.find((skill) => skill.skillId === skillId);
      if (!previous) throw new KnowledgeSkillError("knowledge_skill_not_found");
      if (previous.revision !== expectedRevision) throw new KnowledgeSkillError("knowledge_skill_revision_conflict");
      if (previous.revision >= PERSONAL_SKILL_LIMITS.revision) throw new KnowledgeSkillError("knowledge_skill_revision_limit");
      updated = Object.freeze({ ...change(previous), revision: previous.revision + 1 });
      return documents.map((skill) => skill.skillId === skillId ? updated! : skill);
    });
    return updated!;
  }

  function update(skillId: string, expectedRevision: number, changes: PersonalSkillChanges): Promise<PersonalSkillRecord> {
    return mutatePersonalSkill(skillId, expectedRevision, (previous) => {
      if (previous.archived) throw new KnowledgeSkillError("knowledge_skill_archived");
      const content = validatePersonalSkillInput({ ...previous, ...changes });
      return { ...previous, ...content };
    });
  }

  async function create(input: PersonalSkillInput): Promise<PersonalSkillRecord> {
    const content = validatePersonalSkillInput(input);
    const skill: PersonalSkillRecord = Object.freeze({ ...content,
      skillId: "personal-" + randomUUID(), source: "personal", revision: 1, archived: false });
    await repository.update((documents) => {
      if (system.read(skill.skillId) || documents.some(({ skillId }) => skillId === skill.skillId))
        throw new KnowledgeSkillError("knowledge_skill_id_duplicate");
      return [...documents, skill];
    });
    return skill;
  }

  const service = Object.freeze<PersonalSkillManagementService>({
    create,
    async list() {
      return repository.read().map(({ content: _content, ...summary }) => Object.freeze(summary));
    },
    async get(skillId) {
      assertPersonalTarget(skillId);
      return repository.read().find((skill) => skill.skillId === skillId);
    },
    updateContent: (skillId, expectedRevision, content) => update(skillId, expectedRevision, { content }),
    archive: (skillId, expectedRevision) => mutatePersonalSkill(
      skillId, expectedRevision, (previous) => ({ ...previous, archived: true }),
    ),
    restore: (skillId, expectedRevision) => mutatePersonalSkill(
      skillId, expectedRevision, (previous) => ({ ...previous, archived: false }),
    ),
  });

  return Object.freeze({ service, update, create });
}
