import type { ToolImplementationOutput } from "../../../capabilities/tool-types.js";
import {
  KNOWLEDGE_SKILL_READ_MAX_ITEMS,
  type KnowledgeSkillStore,
} from "../../knowledge-skills/store.js";
import { knowledgeSkillDocumentsReadOutput, knowledgeSkillFailure } from "./tool-output.js";
import { isKnowledgeSkillReadReference, resolveKnowledgeSkillReadTargets } from "./read-targets.js";

function hasValidSkillIds(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0 || value.length > KNOWLEDGE_SKILL_READ_MAX_ITEMS) return false;
  if (!value.every(isKnowledgeSkillReadReference)) return false;
  return new Set(value).size === value.length;
}

/** One ordinary read result; never report a partial document set as success. */
export function executeKnowledgeSkillsReadMany(
  store: KnowledgeSkillStore,
  skillIds: unknown,
): ToolImplementationOutput {
  if (!hasValidSkillIds(skillIds)) return knowledgeSkillFailure("knowledge_skill_ids_invalid");
  const resolved = resolveKnowledgeSkillReadTargets(store, skillIds);
  if (!resolved.ok) return knowledgeSkillFailure(resolved.errorCode);
  return knowledgeSkillDocumentsReadOutput(resolved.skills);
}
