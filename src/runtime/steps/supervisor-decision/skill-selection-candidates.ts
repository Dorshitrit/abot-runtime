import type { KnowledgeSkillMetadata } from "../../knowledge-skills/store.js";
import { isKnowledgeSkillStorageFailure } from "../../knowledge-skills/personal-contracts.js";
import type { RoleSkillRead } from "../../orchestration/role-calls/skill-read.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { collectSuccessfulSkillReadIdentities } from "./skill-read-state.js";

/** One selection-call snapshot; only captured successful documents establish prior reads. */
export function snapshotSupervisorSkillCandidates(
  request: RequestExecutionScope,
  reads: readonly RoleSkillRead[],
) {
  const successfulReads = collectSuccessfulSkillReadIdentities(reads);
  const loadedIds = new Set(successfulReads.map(({ skillId }) => skillId));
  const candidates = readCandidateMetadata(request)
    .filter(({ skillId }) => !loadedIds.has(skillId))
    .map(({ skillId, name, description }) => Object.freeze({ skillId, name, description }));
  return Object.freeze({
    candidates: Object.freeze(candidates),
    skillIds: Object.freeze(candidates.map(({ skillId }) => skillId)),
    successfulReads: Object.freeze(successfulReads),
  });
}

function readCandidateMetadata(request: RequestExecutionScope): readonly KnowledgeSkillMetadata[] {
  try { return request.knowledgeSkillStore?.list() ?? []; }
  catch (error) {
    if (isKnowledgeSkillStorageFailure(error)) return [];
    throw error;
  }
}
