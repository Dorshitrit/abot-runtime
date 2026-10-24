import { invokeStructuredModelStep, StructuredModelInvalidOutputError, type StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS } from "../../model/repair-prompts.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { SupervisorSkillSelectionWindow } from "../../request/supervisor-skill-selection-window.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import { SUPERVISOR_DECISION_MODEL_STEP, type SupervisorDecisionDiagnosticContext, type SupervisorResumeContext } from "./contracts.js";
import { buildSupervisorPreparationInput } from "./preparation-input.js";
import { buildSupervisorSkillSelectionInput } from "./skill-selection-input.js";
import { buildSupervisorPresentationInstructions, createSupervisorPresentationFormat, parseSupervisorPresentationOutput, type SupervisorPresentation } from "./presentation.js";
import { hasEligibleSkillCandidates, parseSupervisorSkillSelectionOutput, type SupervisorSkillSelection } from "./skill-selection.js";

export async function prepareSupervisorDecision(request: RequestExecutionScope, options: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  allowSkillReads: boolean;
  skillReadHead?: RoleCallLedgerHead;
  resume?: SupervisorResumeContext;
  skillSelectionWindow: SupervisorSkillSelectionWindow;
  boundSteeringVersion?: number;
}): Promise<{ presentation: SupervisorPresentation; selection: SupervisorSkillSelection; steeringVersion: number }> {
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  const { skillSelectionWindow } = options;
  let steeringVersion = options.boundSteeringVersion;
  let presentation: SupervisorPresentation = {};
  if (needsSupervisorPresentation(options)) {
    const diagnostic = { ...options.diagnostic, decisionPhase: "presentation" as const };
    const input = buildSupervisorPreparationInput(request, {
      instructions: buildSupervisorPresentationInstructions(options),
      format: createSupervisorPresentationFormat(options), diagnostic,
    });
    const accepted = await invokePreparationPhase(request, {
      input, diagnostic, boundSteeringVersion: steeringVersion,
      parse: (text) => parseSupervisorPresentationOutput(text, options),
    });
    presentation = accepted.decision;
    steeringVersion = accepted.steeringVersion;
  }
  if (!canSelectSupervisorSkills(options)) return { presentation, selection: { action: "continue" }, steeringVersion: steeringVersion ?? steering.snapshot().version };
  const diagnostic = { ...options.diagnostic, decisionPhase: "skill_selection" as const };
  const input = buildSupervisorSkillSelectionInput(request, {
    skillReadHead: options.skillReadHead, diagnostic, ...(options.resume ? { resume: options.resume } : {}),
  });
  if (!hasEligibleSkillCandidates(input.eligibleSkillIds)) {
    skillSelectionWindow.complete();
    return { presentation, selection: { action: "continue" }, steeringVersion: steeringVersion ?? steering.snapshot().version };
  }
  let accepted: { decision: SupervisorSkillSelection; steeringVersion: number };
  let rejectedSteeringVersion: number | undefined;
  try {
    accepted = await invokePreparationPhase(request, {
      input, diagnostic, boundSteeringVersion: steeringVersion,
      parse(text) {
        const parsed = parseSupervisorSkillSelectionOutput(text, input.eligibleSkillIds);
        if (!parsed.ok) rejectedSteeringVersion = steering.snapshot().version;
        return parsed;
      },
    });
  } catch (error: unknown) {
    request.abortSignal.throwIfAborted();
    if (!isExhaustedDuplicateSkillSelection(error)) throw error;
    if (rejectedSteeringVersion === undefined) throw error;
    assertBoundModelStepSteeringCurrent(steering, steeringVersion);
    assertBoundModelStepSteeringCurrent(steering, rejectedSteeringVersion);
    skillSelectionWindow.complete();
    traceDebug("runtime.supervisor", "skill_selection.rejected", {
      ...diagnostic, steeringVersion: rejectedSteeringVersion,
      issues: error.issues.map(({ code, path }) => ({ code, path })),
      repairAttempts: error.repairAttempts, disposition: "continue_routing",
    });
    return { presentation, selection: { action: "continue" }, steeringVersion: rejectedSteeringVersion };
  }
  assertBoundModelStepSteeringCurrent(steering, accepted.steeringVersion);
  skillSelectionWindow.complete();
  return { presentation, selection: accepted.decision, steeringVersion: accepted.steeringVersion };
}

function needsSupervisorPresentation(options: { includeAcknowledgement: boolean; includeTitle: boolean }): boolean {
  return options.includeAcknowledgement || options.includeTitle;
}

function canSelectSupervisorSkills(options: {
  allowSkillReads: boolean;
  skillReadHead?: RoleCallLedgerHead;
  skillSelectionWindow: SupervisorSkillSelectionWindow;
}): boolean {
  if (!options.allowSkillReads) return false;
  if (!options.skillSelectionWindow.isOpen()) return false;
  return !options.skillReadHead?.state.skillReads?.some((read) => read.result.outcome === "failed");
}

function isExhaustedDuplicateSkillSelection(error: unknown): error is StructuredModelInvalidOutputError {
  if (!(error instanceof StructuredModelInvalidOutputError)) return false;
  if (error.modelStep !== SUPERVISOR_DECISION_MODEL_STEP) return false;
  if (error.message !== "invalid_supervisor_decision") return false;
  if (error.validationStage !== "domain_parser") return false;
  if (error.repairAttempts !== STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS) return false;
  if (error.issues.length !== 1) return false;
  return error.issues[0]?.code === "skill_selection_ids_duplicate";
}

async function invokePreparationPhase<T>(request: RequestExecutionScope, options: {
  input: ReturnType<typeof buildSupervisorPreparationInput>;
  diagnostic: SupervisorDecisionDiagnosticContext;
  boundSteeringVersion?: number;
  parse: (text: string) => StructuredModelParseResult<T>;
}): Promise<{ decision: T; steeringVersion: number }> {
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  const startedAt = Date.now();
  assertBoundModelStepSteeringCurrent(steering, options.boundSteeringVersion);
  traceDebug("runtime.supervisor", "model.started", { ...options.diagnostic, outputContract: options.input.format.name, messageCount: options.input.context.messages.length });
  const accepted = await invokeStructuredModelStep({
    request, modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    format: options.input.format, messages: options.input.context.messages,
    boundSteeringVersion: options.boundSteeringVersion,
    contextRetention: "exact",
    timeoutReason: "supervisor_decision_timeout", invalidOutputReason: "invalid_supervisor_decision",
    parse(text) {
      const parsed = options.parse(text);
      if (!parsed.ok) return parsed;
      return { ok: true, decision: { decision: parsed.decision, steeringVersion: steering.snapshot().version } };
    },
  });
  traceDebug("runtime.supervisor", "model.completed", { ...options.diagnostic, outputContract: options.input.format.name, durationMs: Date.now() - startedAt });
  return accepted;
}
