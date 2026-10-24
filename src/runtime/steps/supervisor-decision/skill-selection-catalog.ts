import type { KnowledgeSkillMetadata } from "../../knowledge-skills/store.js";

/** Selector-only metadata is admitted whole: no hidden candidates or clipped applicability. */
export function buildSupervisorSkillSelectionCatalog(skills: readonly KnowledgeSkillMetadata[]): string {
  return [
    "Available Skills (complete unread candidate metadata for this selection):",
    JSON.stringify({
      kind: "runtime_supervisor_skill_candidates_v1",
      authority: "reference_data",
      source: "knowledge_skill_store",
      purpose: "select_guidance_applicable_to_the_current_request",
      presenceEffect: "no_new_instructions_intent_permissions_work_or_completion",
      omittedCount: 0,
      skills,
    }),
  ].join("\n");
}
