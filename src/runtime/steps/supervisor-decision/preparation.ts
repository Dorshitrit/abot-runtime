import { invokeStructuredModelStep, type StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import { SUPERVISOR_DECISION_MODEL_STEP, type SupervisorDecisionDiagnosticContext } from "./contracts.js";
import { buildSupervisorPreparationInput } from "./preparation-input.js";
import { buildSupervisorSkillSelectionInput } from "./skill-selection-input.js";
import { buildSupervisorPresentationInstructions, createSupervisorPresentationFormat, parseSupervisorPresentationOutput, type SupervisorPresentation } from "./presentation.js";
import { parseSupervisorSkillSelectionOutput, type SupervisorSkillSelection } from "./skill-selection.js";

export async function prepareSupervisorDecision(request: RequestExecutionScope, options: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  allowSkillReads: boolean;
  skillReadHead?: RoleCallLedgerHead;
  boundSteeringVersion?: number;
}): Promise<{ presentation: SupervisorPresentation; selection: SupervisorSkillSelection; steeringVersion: number }> {
  const steering = resolveRequestSteeringInbox(request.requestSteering);
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
  const input = buildSupervisorSkillSelectionInput(request, { skillReadHead: options.skillReadHead, diagnostic });
  const accepted = await invokePreparationPhase(request, {
    input, diagnostic, boundSteeringVersion: steeringVersion,
    parse: parseSupervisorSkillSelectionOutput,
  });
  return { presentation, selection: accepted.decision, steeringVersion: accepted.steeringVersion };
}

function needsSupervisorPresentation(options: { includeAcknowledgement: boolean; includeTitle: boolean }): boolean {
  return options.includeAcknowledgement || options.includeTitle;
}

function canSelectSupervisorSkills(options: {
  allowSkillReads: boolean;
  skillReadHead?: RoleCallLedgerHead;
}): boolean {
  if (!options.allowSkillReads) return false;
  return !options.skillReadHead?.state.skillReads?.some((read) => read.result.outcome === "failed");
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
