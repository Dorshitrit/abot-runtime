import type { ToolImplementationOutput } from "../../../capabilities/tool-types.js";
import { canWriteKnowledgeSkills, KnowledgeSkillError } from "../../knowledge-skills/personal-contracts.js";
import { isPersonalSkillRevision } from "../../knowledge-skills/personal-documents.js";
import { isKnowledgeSkillId, type KnowledgeSkillStore } from "../../knowledge-skills/store.js";

function requiredText(params: Record<string, unknown>, key: string): string {
  if (typeof params[key] !== "string") throw new KnowledgeSkillError("knowledge_skill_" + key + "_invalid");
  return params[key];
}

export async function executeKnowledgeSkillWrite(
  store: KnowledgeSkillStore, params: Record<string, unknown>,
): Promise<ToolImplementationOutput> {
  if (!canWriteKnowledgeSkills(store)) throw new KnowledgeSkillError("knowledge_skill_read_only");
  const writable = store;
  const content = requiredText(params, "content");
  const skill = params.action === "create_skill"
    ? await store.create({ name: requiredText(params, "name"), description: requiredText(params, "description"), content })
    : await update();
  const { skillId, name, description, source, revision } = skill;
  return {
    ok: true, output: JSON.stringify({ skillId, name, description, source, revision }),
    producedNewInformation: true,
    data: { mutationEvidence: true, skillTitle: name, savedSkillId: skillId },
  };

  async function update() {
    if (!isKnowledgeSkillId(params.skillId)) throw new KnowledgeSkillError("knowledge_skill_id_invalid");
    if (!isPersonalSkillRevision(params.expectedRevision)) throw new KnowledgeSkillError("knowledge_skill_revision_conflict");
    return writable.update(params.skillId, params.expectedRevision, {
      content,
      ...(params.name !== undefined ? { name: requiredText(params, "name") } : {}),
      ...(params.description !== undefined ? { description: requiredText(params, "description") } : {}),
    });
  }
}
