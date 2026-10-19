import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import type { KnowledgeSkillMetadata } from "../../knowledge-skills/store.js";
import { isKnowledgeSkillStorageFailure } from "../../knowledge-skills/personal-contracts.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { SUPERVISOR_DECISION_MODEL_STEP, type SupervisorDecisionDiagnosticContext } from "./contracts.js";
import { buildSupervisorPreparationInput } from "./preparation-input.js";
import { createSupervisorSkillSelectionFormat, SUPERVISOR_SKILL_SELECTION_INSTRUCTIONS } from "./skill-selection.js";

export function buildSupervisorSkillSelectionInput(request: RequestExecutionScope, options: {
  skillReadHead?: RoleCallLedgerHead;
  diagnostic?: SupervisorDecisionDiagnosticContext;
} = {}) {
  const reads = options.skillReadHead?.state.skillReads ?? [];
  const loadedIds = new Set(reads.flatMap((read) =>
    read.operation === "read_skills" && read.result.outcome === "completed"
      ? read.result.skills.map((skill) => skill.skillId) : []));
  const lastList = [...reads].reverse().find((read) => read.operation === "list_skills" && read.result.outcome === "completed");
  const metadata = lastList?.result.outcome === "completed"
    ? lastList.result.skills : readCandidateMetadata(request);
  return buildSupervisorPreparationInput(request, {
    instructions: SUPERVISOR_SKILL_SELECTION_INSTRUCTIONS,
    format: createSupervisorSkillSelectionFormat(),
    diagnostic: options.diagnostic ?? { requestId: request.requestId, modelStep: SUPERVISOR_DECISION_MODEL_STEP, decisionPhase: "skill_selection" },
    availableSkills: metadata.filter((skill) => !loadedIds.has(skill.skillId)),
    expandedCatalog: lastList !== undefined,
  });
}

function readCandidateMetadata(request: RequestExecutionScope): readonly KnowledgeSkillMetadata[] {
  try { return request.knowledgeSkillStore?.list() ?? []; }
  catch (error) {
    if (isKnowledgeSkillStorageFailure(error)) return [];
    throw error;
  }
}
