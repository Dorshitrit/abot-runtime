import { join } from "node:path";
import { builtinKnowledgeSkillStore } from "./catalog.js";
import type { KnowledgeSkillStore } from "./store.js";
import { createPersonalSkillRepository } from "./personal-repository.js";
import { projectPersonalSkillDocument } from "./personal-documents.js";
import { createPersonalSkillManagement } from "./personal-management.js";
import type { ManagedKnowledgeSkillStore } from "./personal-contracts.js";

/** One Store binds discovery, reads and personal authoring within one Runtime environment. */
export function createRuntimeKnowledgeSkillStore(
  runtimeDirectory: string,
  system: KnowledgeSkillStore = builtinKnowledgeSkillStore,
): ManagedKnowledgeSkillStore {
  const repository = createPersonalSkillRepository(join(runtimeDirectory, "skills"));
  const personal = createPersonalSkillManagement(repository, system);
  return Object.freeze<ManagedKnowledgeSkillStore>({
    personalSkills: personal.service,
    list() {
      return [
        ...system.list().map((skill) => ({ ...skill, source: "system" as const })),
        ...repository.read().filter((skill) => !skill.archived)
          .map(({ skillId, name, description }) => ({ skillId, name, description, source: "personal" as const })),
      ];
    },
    read(skillId) {
      const packaged = system.read(skillId);
      if (packaged) return { ...packaged, source: "system" as const };
      const personal = repository.read().find((skill) => skill.skillId === skillId && !skill.archived);
      return personal ? projectPersonalSkillDocument(personal) : undefined;
    },
    async create(input) {
      return projectPersonalSkillDocument(await personal.create(input));
    },
    async update(skillId, expectedRevision, changes) {
      return projectPersonalSkillDocument(await personal.update(skillId, expectedRevision, changes));
    },
  });
}
