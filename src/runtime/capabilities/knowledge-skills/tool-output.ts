import type { ToolImplementationOutput } from "../../../capabilities/tool-types.js";
import type { KnowledgeSkillDocument } from "../../knowledge-skills/store.js";

export function knowledgeSkillFailure(errorCode: string): ToolImplementationOutput {
  return {
    ok: false, output: errorCode, error: errorCode, errorCode,
    producedNewInformation: false, data: { mutationEvidence: false },
  };
}

export function knowledgeSkillDocumentOutput(skill: KnowledgeSkillDocument) {
  return { skillId: skill.skillId, name: skill.name, content: skill.content,
    ...(skill.source ? { source: skill.source, description: skill.description } : {}),
    ...(skill.revision !== undefined ? { revision: skill.revision } : {}),
  };
}

export function knowledgeSkillDocumentsReadOutput(
  skills: readonly KnowledgeSkillDocument[],
): ToolImplementationOutput {
  return {
    ok: true,
    output: JSON.stringify({ skills: skills.map(knowledgeSkillDocumentOutput) }),
    producedNewInformation: true,
    data: { mutationEvidence: false, itemCount: skills.length,
      skillTitle: skills.map(({ name }) => name).join(", ") },
  };
}
