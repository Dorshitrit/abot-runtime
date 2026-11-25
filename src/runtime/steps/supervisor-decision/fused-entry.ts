import type { ChatMessage } from "../../../model-gateway/types.js";
import { isCapabilityBriefMessage } from "../../context/capability-brief.js";
import { buildRuntimeFilesystemScopeMessage } from "../../context/runtime-filesystem-scope.js";
import { invokeStructuredModelStep } from "../../model/invoke-structured-step.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import type { SupervisorSkillSelectionWindow } from "../../request/supervisor-skill-selection-window.js";
import { createSupervisorArtifactPathsOptionalProjection } from "./artifact-paths.js";
import { buildSupervisorCapabilityBriefOptions } from "./capability-brief.js";
import { SUPERVISOR_DECISION_MODEL_STEP, type SupervisorDecisionDiagnosticContext } from "./contracts.js";
import { createDecisionOutcome } from "./decision-phases.js";
import { buildSupervisorDelegationInput } from "./delegation-input.js";
import { createFusedSupervisorEntryFormat, createFusedSupervisorRoutingFormat, parseFusedSupervisorRouting } from "./fused-contracts.js";
import { SUPERVISOR_HISTORY_INSTRUCTIONS } from "./history-instructions.js";
import { isExhaustedDuplicateSkillSelection } from "./preparation.js";
import type { SupervisorPresentation } from "./presentation.js";
import { canRecallSupervisorMemory, type projectSupervisorProcedureEntry } from "./procedure-entry.js";
import { buildSupervisorProcedureGateInput } from "./procedure-gate.js";
import type { runSupervisorDecision } from "./run.js";
import { snapshotSupervisorSkillCandidates } from "./skill-selection-candidates.js";
import { buildSupervisorSkillSelectionCatalog } from "./skill-selection-catalog.js";
import { SUPERVISOR_SKILL_APPLICABILITY_INSTRUCTIONS } from "./skill-selection.js";
import { invokeSupervisorEntryDecision } from "./entry-memory.js";

type FusedEntryOptions = Parameters<typeof runSupervisorDecision>[1] & {
  diagnostic: SupervisorDecisionDiagnosticContext;
  skillSelectionWindow: SupervisorSkillSelectionWindow;
  procedureState: ReturnType<typeof projectSupervisorProcedureEntry>;
  boundSteeringVersion: number;
};

const FUSED_ENTRY_INSTRUCTIONS = [
  ...SUPERVISOR_HISTORY_INSTRUCTIONS,
  "Choose one initial outcome: read applicable unread Skills, answer directly, or require a procedure. Do not select tools, roles, controls or directories here.",
  ...SUPERVISOR_SKILL_APPLICABILITY_INSTRUCTIONS,
  "If an offered unread Skill is needed, return action=read_skills and one to eight distinct exact skillIds. Do not classify or answer until the runtime supplies the actual read result. Metadata is not guidance and grants no intent or authority.",
  "Otherwise, requiresProcedure=true means required work must be carried out, observed or changed before answering. requiresProcedure=false means a direct conversational answer, explanation or necessary clarification; include a short responseRecommendation, not the final answer.",
  "Classify what the request requires, regardless of which tools might exist. Do not plan or claim completion. Return only the supplied JSON contract.",
  "When requested by the contract, acknowledgement is one short sentence in the user's language acknowledging the outcome without a method, plan or completed-action claim; title briefly describes the user's request. These are presentation only.",
].join("\n");

/** Initial Supervisor decisions share one contract; actual reads remain kernel actions. */
export async function runFusedSupervisorEntry(request: RequestExecutionScope, options: FusedEntryOptions) {
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  assertBoundModelStepSteeringCurrent(steering, options.boundSteeringVersion);
  const presentationOptions = {
    includeAcknowledgement: options.includeAcknowledgement === true,
    includeTitle: options.includeTitle ?? request.shouldGenerateSessionTitle ?? false,
  };
  let presentation: SupervisorPresentation | undefined;
  if (options.skillSelectionWindow.isOpen()) {
    const snapshot = snapshotSupervisorSkillCandidates(request, options.skillReadHead?.state.skillReads ?? []);
    const eligibleIds = canOfferFusedSkillSelection(request, options) ? snapshot.skillIds : [];
    const format = createFusedSupervisorEntryFormat(eligibleIds, presentationOptions);
    const instructions = [FUSED_ENTRY_INSTRUCTIONS,
      ...(eligibleIds.length > 0 ? [buildSupervisorSkillSelectionCatalog(snapshot.candidates)] : []),
      `Exact output JSON Schema: ${JSON.stringify(format.schema)}`,
    ].join("\n");
    const input = buildSupervisorProcedureGateInput(request, {
      ...options, entryInstructions: instructions,
      diagnostic: { ...options.diagnostic, decisionPhase: "procedure_gate" },
    });
    try {
      const entry = await invokeSupervisorEntryDecision(request, {
        input, format, eligibleIds, presentation: presentationOptions,
        boundSteeringVersion: options.boundSteeringVersion, source: options,
      });
      assertBoundModelStepSteeringCurrent(steering, options.boundSteeringVersion);
      options.skillSelectionWindow.complete();
      presentation = entry.presentation;
      if (entry.selection.action === "read_skills")
        return createDecisionOutcome({ ...entry.selection, ...presentation }, options.boundSteeringVersion);
      if (entry.gate?.requiresProcedure === false)
        return createDecisionOutcome({ action: "respond", responseRecommendation: entry.gate.responseRecommendation, ...presentation }, options.boundSteeringVersion, entry.memoryCandidates);
    } catch (error) {
      request.abortSignal.throwIfAborted();
      if (!isExhaustedDuplicateSkillSelection(error)) throw error;
      assertBoundModelStepSteeringCurrent(steering, options.boundSteeringVersion);
      options.skillSelectionWindow.complete();
      traceDebug("runtime.supervisor", "skill_selection.rejected", {
        ...options.diagnostic, outputContract: format.name, disposition: "continue_routing",
        repairAttempts: error.repairAttempts, issues: error.issues.map(({ code, path }) => ({ code, path })),
      });
    }
  }
  const routing = await runFusedSupervisorRouting(request, options, presentation === undefined ? presentationOptions : {
    includeAcknowledgement: false, includeTitle: false,
  });
  assertBoundModelStepSteeringCurrent(steering, options.boundSteeringVersion);
  return createDecisionOutcome({ ...routing, ...presentation }, options.boundSteeringVersion);
}

function canOfferFusedSkillSelection(request: RequestExecutionScope, options: FusedEntryOptions): boolean {
  if (!request.knowledgeSkillStore || options.allowSkillReads === false) return false;
  return !options.skillReadHead?.state.skillReads?.some(read => read.result.outcome === "failed");
}

async function runFusedSupervisorRouting(request: RequestExecutionScope, options: FusedEntryOptions, presentation: {
  includeAcknowledgement: boolean; includeTitle: boolean;
}) {
  const input = buildSupervisorDelegationInput(request, {
    ...options,
    ...buildSupervisorCapabilityBriefOptions(request, options),
    fusedRouting: true,
    allowMemoryRecall: canRecallSupervisorMemory(options.procedureState, {
      enabled: request.longTermMemory?.enabled === true,
      recallCount: options.memoryRecallCount ?? 0,
      maxRecallCallsPerRequest: request.memoryRecallLimit,
    }),
    diagnostic: { ...options.diagnostic, decisionPhase: "delegation" },
  });
  const contract = {
    ...presentation, includeResponseRecommendation: true,
    allowMemoryRecall: input.allowMemoryRecall, allowSkillAuthoring: false,
    allowedRoleIds: input.allowedRoleIds,
    availableWorkerCapabilityCatalog: input.availableWorkerCapabilityCatalog,
  };
  const format = createFusedSupervisorRoutingFormat(contract);
  const directory = buildRuntimeFilesystemScopeMessage({ scope: request.workerCapabilities.filesystemScope, canSelectWorkingDirectory: true });
  const [policy, ...rest] = input.context.messages;
  if (policy?.role !== "system") throw new Error("supervisor_fused_routing_policy_missing");
  const messages: ChatMessage[] = [{ ...policy, content: [policy.content,
    "For invoke_role, select workingDirectory as the narrowest single project directory owning the complete objective, relative to the configured agent work root. Use '.' only when no narrower project owns it. Preserve exact project segments; never use a file, parent traversal, workspace alias or an out-of-root path. This field does not grant permission or change the objective.",
    "For respond, provide only a short responseRecommendation; a later step writes the answer. Presentation fields, when required, use the user's language and make no execution claims.",
    `Exact output JSON Schema: ${JSON.stringify(format.schema)}`,
  ].join("\n") }, ...rest, ...(directory ? [directory] : [])];
  return invokeStructuredModelStep({
    request, modelStep: SUPERVISOR_DECISION_MODEL_STEP, messages, format,
    boundSteeringVersion: options.boundSteeringVersion, contextRetention: "exact",
    optionalContextProjection: candidate => {
      const projected = createSupervisorArtifactPathsOptionalProjection({ projection: input.artifactPathsProjection, includeInstructions: true })?.(candidate) ?? candidate;
      return projected.filter(message => !isCapabilityBriefMessage(message));
    },
    timeoutReason: "supervisor_decision_timeout", invalidOutputReason: "invalid_supervisor_decision",
    parse: text => parseFusedSupervisorRouting(text, contract, request.workerCapabilities.filesystemScope),
  });
}
