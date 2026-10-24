import type { ChatMessage } from "../../../model-gateway/types.js";
import type { KnowledgeSkillMetadata } from "../../knowledge-skills/store.js";
import type { RoleSkillRead } from "../../orchestration/role-calls/skill-read.js";

export const SUPERVISOR_SKILL_READ_STATE_KIND = "runtime_supervisor_skill_read_state_v1";
const MAX_DISPLAYED_SKILLS = 32;
const MAX_DISPLAYED_NAME_LENGTH = 160;
type SuccessfulSkillReadIdentity = Pick<KnowledgeSkillMetadata, "skillId" | "name">;

/** Reuse captured identities; neither selectors nor current Store metadata prove a read. */
export function collectSuccessfulSkillReadIdentities(
  reads: readonly RoleSkillRead[],
): readonly SuccessfulSkillReadIdentity[] {
  const identities = new Map<string, SuccessfulSkillReadIdentity>();
  for (const read of reads) {
    const isSuccessfulDocumentRead = read.operation === "read_skills" && read.result.outcome === "completed";
    if (!isSuccessfulDocumentRead) continue;
    for (const { skillId, name } of read.result.skills) {
      identities.delete(skillId);
      identities.set(skillId, { skillId, name });
    }
  }
  return [...identities.values()];
}

/** Derived selection-only reference; full document evidence keeps its existing routing lane. */
export function buildSupervisorSkillReadStateMessages(
  requestId: string,
  identities: readonly SuccessfulSkillReadIdentity[],
): readonly ChatMessage[] {
  if (identities.length === 0) return [];
  const skills = identities.slice(-MAX_DISPLAYED_SKILLS).reverse().map(({ skillId, name }) => ({
    skillId,
    name: name.slice(0, MAX_DISPLAYED_NAME_LENGTH),
    nameTruncated: name.length > MAX_DISPLAYED_NAME_LENGTH,
  }));
  return [{
    role: "system",
    content: JSON.stringify({
      kind: SUPERVISOR_SKILL_READ_STATE_KIND,
      authority: "canonical_runtime_state",
      source: "role_call_ledger.skillReads",
      purpose: "identify_skills_already_read_successfully",
      applicability: "current_request_skill_selection_only",
      presenceEffect: "no_new_instructions_intent_permissions_work_or_completion",
      requestId,
      outcome: "completed",
      entryOrder: "latest_successful_read_first",
      totalCount: identities.length,
      omittedCount: identities.length - skills.length,
      omissionMeaning: "omitted_skills_may_also_have_been_read",
      skills,
    }),
  }];
}
