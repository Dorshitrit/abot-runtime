import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { buildCoreSkillReadContextMessages } from "../../context/core-skill-read-context.js";
import { projectRequestContext } from "../../context/request-context.js";
import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import { invokeStructuredModelStep, type StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { createStructuredDecisionEnvelopeSchema, readStructuredDecisionEnvelope, structuredDecisionVariantSchemaPath } from "../../model/structured-decision-envelope.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import { SUPERVISOR_DECISION_MODEL_STEP, type SupervisorDecisionDiagnosticContext } from "./contracts.js";
import { projectSupervisorResponseRecommendation, SUPERVISOR_RESPONSE_RECOMMENDATION_MAX_LENGTH } from "./response-recommendation.js";
import { projectSupervisorProcedureRecall } from "./procedure-recall.js";
import { projectSupervisorProcedureMemory } from "./procedure-memory.js";
import { SUPER_SKILL_GUIDANCE_INSTRUCTION } from "../supervisor-skill-instructions.js";

export type SupervisorProcedureGateDecision = Readonly<
  | { requiresProcedure: true }
  | { requiresProcedure: false; responseRecommendation?: string }
>;

const PROCEDURE_GATE_INSTRUCTIONS = [
  "Decide only whether fulfilling the current user request requires a procedure before answering.",
  "requiresProcedure=true: work must be carried out, observed or changed before a grounded final reply can fulfill the request.",
  "requiresProcedure=false: the requested outcome is a direct conversational answer, explanation, or necessary clarification.",
  "Judge what the request requires, regardless of which tools exist. Tool availability and role/tool selection belong to later stages.",
  "Do not execute work, plan it, or claim completion. Return only the supplied JSON. If false, include a short response recommendation, not the final answer.",
].join("\n");

export function createSupervisorProcedureGateFormat(): ModelGatewayJsonSchemaFormat {
  return {
    type: "json_schema", name: "supervisor_procedure_gate", strict: true,
    schema: createStructuredDecisionEnvelopeSchema([
      {
        type: "object", properties: { requiresProcedure: { type: "boolean", const: true } },
        required: ["requiresProcedure"], additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          requiresProcedure: { type: "boolean", const: false },
          responseRecommendation: { type: "string", minLength: 1, maxLength: SUPERVISOR_RESPONSE_RECOMMENDATION_MAX_LENGTH },
        },
        required: ["requiresProcedure", "responseRecommendation"], additionalProperties: false,
      },
    ]),
    postValidatedSchemaConstraints: [{
      keyword: "maxLength",
      path: `${structuredDecisionVariantSchemaPath(1, 2)}/properties/responseRecommendation/maxLength`,
    }],
  };
}

export function parseSupervisorProcedureGateOutput(text: string): StructuredModelParseResult<SupervisorProcedureGateDecision> {
  let record: Record<string, unknown> | undefined;
  try { record = readStructuredDecisionEnvelope(JSON.parse(text)); } catch { /* Rejected below. */ }
  if (isProcedureRequiredDecision(record)) {
    return { ok: true, decision: Object.freeze({ requiresProcedure: true }) };
  }
  if (isDirectResponseDecision(record)) {
    return { ok: true, decision: Object.freeze({
      requiresProcedure: false, ...projectSupervisorResponseRecommendation(record.responseRecommendation),
    }) };
  }
  return {
    ok: false, stage: "domain_parser", issues: [{
      code: "supervisor_procedure_gate_invalid", path: "decision",
      message: "Return requiresProcedure as a boolean. Only false may include responseRecommendation; supply a non-empty recommendation of at most 300 characters. Include no other fields.",
    }],
  };
}

function isProcedureRequiredDecision(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  if (record.requiresProcedure !== true) return false;
  return Object.keys(record).length === 1;
}

function isDirectResponseDecision(record: Record<string, unknown> | undefined): record is { requiresProcedure: false; responseRecommendation?: unknown } {
  if (!record) return false;
  if (record.requiresProcedure !== false) return false;
  return Object.keys(record).every((key) => key === "requiresProcedure" || key === "responseRecommendation");
}

type ProcedureGateContextOptions = Readonly<{
  diagnostic: SupervisorDecisionDiagnosticContext;
  skillReadHead?: RoleCallLedgerHead;
  initialMemoryMessage?: ChatMessage;
  memoryRecallMessage?: ChatMessage;
  boundSteeringVersion?: number;
}>;

function projectProcedureMemoryContext(request: RequestExecutionScope, options: ProcedureGateContextOptions) {
  if (!request.longTermMemory?.enabled) return undefined;
  if (!options.memoryRecallMessage) return projectSupervisorProcedureMemory(options.initialMemoryMessage);
  return projectSupervisorProcedureRecall(options.memoryRecallMessage, {
    requestId: request.requestId,
    callId: options.diagnostic.callId ?? "",
    steeringVersion: options.boundSteeringVersion ?? 0,
  });
}

export function buildSupervisorProcedureGateInput(request: RequestExecutionScope, options: ProcedureGateContextOptions) {
  const format = createSupervisorProcedureGateFormat();
  const memory = projectProcedureMemoryContext(request, options);
  const skillMessages = buildCoreSkillReadContextMessages(options.skillReadHead, "delegate");
  const hasSkillReadContext = skillMessages.length > 0;
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig, agentMode: request.agentMode,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    configuredInstructionPolicy: "omit",
    ...(request.modelPreference ? { modelPreference: request.modelPreference } : {}),
    ...(request.reasoningPreference ? { reasoningPreference: request.reasoningPreference } : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const context = projectRequestContext({
    instructions: [PROCEDURE_GATE_INSTRUCTIONS,
      ...(hasSkillReadContext ? [SUPER_SKILL_GUIDANCE_INSTRUCTION] : []),
      ...(memory ? [memory.instructions] : [])].join("\n"), format,
    prompt: request.prompt, historyMessages: [], budget,
    referenceMessages: [...skillMessages, ...(memory ? [memory.message] : [])],
    diagnostic: options.diagnostic, onEvent: request.onEvent,
    deferCompactionFailure: true,
  });
  return { modelStep: SUPERVISOR_DECISION_MODEL_STEP, format, context };
}

export async function runSupervisorProcedureGate(request: RequestExecutionScope, options: ProcedureGateContextOptions): Promise<{ decision: SupervisorProcedureGateDecision; steeringVersion: number }> {
  const diagnostic = { ...options.diagnostic, decisionPhase: "procedure_gate" as const };
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  const startedAt = Date.now();
  try {
    assertBoundModelStepSteeringCurrent(steering, options.boundSteeringVersion);
    const input = buildSupervisorProcedureGateInput(request, { ...options, diagnostic });
    traceDebug("runtime.supervisor", "model.started", {
      ...diagnostic, outputContract: input.format.name, messageCount: input.context.messages.length,
    });
    const accepted = await invokeStructuredModelStep({
      request, modelStep: SUPERVISOR_DECISION_MODEL_STEP,
      messages: input.context.messages, format: input.format,
      boundSteeringVersion: options.boundSteeringVersion, contextRetention: "exact",
      configuredInstructionPolicy: "omit",
      timeoutReason: "supervisor_decision_timeout", invalidOutputReason: "invalid_supervisor_decision",
      parse(text) {
        const parsed = parseSupervisorProcedureGateOutput(text);
        if (!parsed.ok) return parsed;
        return { ok: true, decision: { decision: parsed.decision, steeringVersion: steering.snapshot().version } };
      },
    });
    request.abortSignal.throwIfAborted();
    assertBoundModelStepSteeringCurrent(steering, accepted.steeringVersion);
    traceDebug("runtime.supervisor", "model.completed", {
      ...diagnostic, outputContract: input.format.name, durationMs: Date.now() - startedAt,
      requiresProcedure: accepted.decision.requiresProcedure,
    });
    return accepted;
  } catch (error: unknown) {
    traceDebug("runtime.supervisor", "model.failed", {
      ...diagnostic, durationMs: Date.now() - startedAt,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}
