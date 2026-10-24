import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { SUPERVISOR_DECISION_MODEL_STEP, type SupervisorDecisionDiagnosticContext, type SupervisorResumeContext } from "./contracts.js";
import { buildSupervisorPreparationInput } from "./preparation-input.js";
import { buildSupervisorSkillReadStateMessages } from "./skill-read-state.js";
import { createSupervisorSkillSelectionFormat, SUPERVISOR_SKILL_SELECTION_INSTRUCTIONS } from "./skill-selection.js";
import { snapshotSupervisorSkillCandidates } from "./skill-selection-candidates.js";
import { buildSupervisorSkillSelectionCatalog } from "./skill-selection-catalog.js";
import { buildSupervisorSkillSelectionContinuationMessages, SUPERVISOR_SKILL_SELECTION_CONTINUATION_INSTRUCTIONS } from "./skill-selection-continuation.js";

export function buildSupervisorSkillSelectionInput(request: RequestExecutionScope, options: {
  skillReadHead?: RoleCallLedgerHead;
  resume?: SupervisorResumeContext;
  diagnostic?: SupervisorDecisionDiagnosticContext;
} = {}) {
  const continuationMessages = buildSupervisorSkillSelectionContinuationMessages(request.requestId, {
    head: options.skillReadHead, ...(options.resume ? { resume: options.resume } : {}),
  });
  const snapshot = snapshotSupervisorSkillCandidates(request, options.skillReadHead?.state.skillReads ?? []);
  const input = buildSupervisorPreparationInput(request, {
    instructions: [
      SUPERVISOR_SKILL_SELECTION_INSTRUCTIONS,
      ...(options.resume ? [SUPERVISOR_SKILL_SELECTION_CONTINUATION_INSTRUCTIONS] : []),
      buildSupervisorSkillSelectionCatalog(snapshot.candidates),
    ].join("\n"),
    format: createSupervisorSkillSelectionFormat(snapshot.skillIds),
    diagnostic: options.diagnostic ?? { requestId: request.requestId, modelStep: SUPERVISOR_DECISION_MODEL_STEP, decisionPhase: "skill_selection" },
    referenceMessages: [
      ...buildSupervisorSkillReadStateMessages(request.requestId, snapshot.successfulReads),
      ...continuationMessages,
    ],
  });
  return { ...input, eligibleSkillIds: snapshot.skillIds };
}
