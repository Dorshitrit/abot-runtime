import { isKnowledgeSkillStorageFailure } from "./personal-contracts.js";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import { CORE_TOOL_CONTRACTS } from "../capabilities/core-tool-contracts.js";
import type { KnowledgeSkillMetadata, KnowledgeSkillStore } from "./store.js";

export interface AvailableSkillsSource {
  getAvailableSkills(): readonly KnowledgeSkillMetadata[];
}

/** Project only metadata whose READ operation is available in this request. */
export function projectAvailableSkills(
  store: KnowledgeSkillStore | undefined,
  tools: readonly ToolAvailabilityEntry[] | undefined,
): readonly KnowledgeSkillMetadata[] {
  const canRead = tools?.some(({ toolName, operationId }) =>
    toolName === CORE_TOOL_CONTRACTS.skills.name && (operationId === "read_skill" || operationId === "read_skills"));
  if (!canRead || !store) return [];
  try {
    return store.list().map(({ skillId, name, description }) => ({ skillId, name, description }));
  } catch (error) {
    // Discovery is optional; the ordinary tool path reports the storage failure.
    if (isKnowledgeSkillStorageFailure(error)) return [];
    throw error;
  }
}
