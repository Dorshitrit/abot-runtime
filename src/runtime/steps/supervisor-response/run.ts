import { resolveMemoryRecallSteeringVersion } from "../../long-term-memory/recall-binding.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import {
  invokeRepairableRawModelStep,
  type RawModelValidationResult,
} from "../../model/invoke-raw-step.js";
import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import { createPolicyModelStepCompactionController } from "../../context/super-compaction/routing.js";
import { superCompactionFailureOwner } from "../../context/super-compaction-failure-owner.js";
import { createSessionMemoryAwareCompactionController } from "../../context/session-memory/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import {
  SUPERVISOR_RESPONSE_MODEL_STEP,
  type SupervisorResponseCallIdentity,
  type SupervisorResponseDiagnosticContext,
  type SupervisorResponseResumeContext,
} from "./contracts.js";
import {
  traceSupervisorResponseModelCompleted,
  traceSupervisorResponseModelFailed,
  traceSupervisorResponseModelStarted,
} from "./diagnostics.js";
import {
  buildSupervisorMemoryAuthoringInput,
  buildSupervisorResponseInput,
} from "./input.js";
import { buildSupervisorResponseRepairHint } from "./prompt.js";
import { SUPERVISOR_DECISION_MODEL_STEP } from "../supervisor-decision/contracts.js";
import {
  resolveRequestSteeringInbox,
  type RequestSteeringSnapshot,
} from "../../request/request-steering.js";
import type { RootAuthoredResponse } from "../../long-term-memory/contracts.js";
import { authorSupervisorMemoryCandidates } from "./memory-authoring.js";
import {
  canAuthorConversationMemory,
  prepareConversationMemoryAuthoring,
} from "../../long-term-memory/conversation-authoring/context.js";
import {
  assertBoundModelStepSteeringCurrent,
  isModelStepSteeringSuperseded,
} from "../../model/model-step-steering.js";
import {
  automationResponseFormat,
  validateAutomationResponse,
} from "../../request/automation-output-contract.js";

const SUPERVISOR_RESPONSE_MAX_REPAIR_ATTEMPTS = 1;

export async function runSupervisorResponse(
  request: RequestExecutionScope,
  options: Readonly<{
    responseRecommendation?: string;
    responseRecommendationOrigin?: "skill_authoring_no_save";
    memoryRecallMessage?: ChatMessage;
    initialMemoryMessage?: ChatMessage;
    call: SupervisorResponseCallIdentity;
    toolResults: RequestToolResultsView;
    skillReadHead?: RoleCallLedgerHead;
    resume?: SupervisorResponseResumeContext;
  }>,
): Promise<string> {
  const authored = await runSupervisorAuthoredResponse(request, options);
  return authored.finalResponse;
}

export async function runSupervisorAuthoredResponse(
  request: RequestExecutionScope,
  options: Readonly<{
    responseRecommendation?: string;
    responseRecommendationOrigin?: "skill_authoring_no_save";
    memoryRecallMessage?: ChatMessage;
    initialMemoryMessage?: ChatMessage;
    call: SupervisorResponseCallIdentity;
    toolResults: RequestToolResultsView;
    skillReadHead?: RoleCallLedgerHead;
    resume?: SupervisorResponseResumeContext;
    steeringSnapshot?: RequestSteeringSnapshot;
  }>,
): Promise<RootAuthoredResponse> {
  const requestSteering = resolveRequestSteeringInbox(request.requestSteering);
  const steeringSnapshot =
    options.steeringSnapshot ?? requestSteering.snapshot();
  const memoryEnabled = request.longTermMemory?.enabled === true;
  const memoryAuthoringVersion =
    memoryEnabled && request.longTermMemory?.learning
      ? steeringSnapshot.version
      : undefined;
  const boundSteeringVersion =
    resolveMemoryRecallSteeringVersion(
      options.memoryRecallMessage,
      request.requestId,
      options.call.callId,
    ) ??
    memoryAuthoringVersion ??
    (options.responseRecommendation !== undefined
      ? options.steeringSnapshot?.version
      : undefined);
  assertBoundModelStepSteeringCurrent(requestSteering, boundSteeringVersion);
  const memoryMessage = memoryEnabled
    ? options.memoryRecallMessage ?? options.initialMemoryMessage
    : undefined;
  const inputOptions = {
    ...options,
    ...(memoryMessage ? { longTermMemoryMessage: memoryMessage } : {}),
  };
  const memoryAuthoringContext = memoryEnabled
    ? await prepareConversationMemoryAuthoring(request, steeringSnapshot)
    : undefined;
  assertBoundModelStepSteeringCurrent(requestSteering, boundSteeringVersion);
  const memoryCandidates = canAuthorConversationMemory(
    request,
    memoryAuthoringContext,
  )
    ? await authorSupervisorMemoryCandidates({
        request,
        boundSteeringVersion,
        ...(memoryAuthoringContext ? { memoryAuthoringContext } : {}),
        messages: buildSupervisorMemoryAuthoringInput(request, {
          ...inputOptions,
          ...(memoryAuthoringContext
            ? { memoryAuthoringMessage: memoryAuthoringContext.message }
            : {}),
        }).context.messages,
        contextCompaction: createSupervisorResponseCompaction(request, options),
      })
    : Object.freeze([]);
  const input = buildSupervisorResponseInput(request, {
    ...inputOptions,
    ...(memoryEnabled ? { memoryCandidateCount: memoryCandidates.length } : {}),
    ...(memoryEnabled
      ? {
          hasDirectMemorySaveRequest: memoryCandidates.some(
            (candidate) => candidate.assessment?.explicitlyRequested,
          ),
        }
      : {}),
  });
  const diagnostic: SupervisorResponseDiagnosticContext = {
    requestId: request.requestId,
    modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
    ...options.call,
  };
  const startedAt = Date.now();

  traceSupervisorResponseModelStarted({
    diagnostic,
    messageCount: input.context.messages.length,
    messageCharacterCount: input.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
  });

  try {
    const finalResponse = await invokeRepairableRawModelStep({
      request,
      modelStep: input.modelStep,
      messages: input.context.messages,
      contextCompaction: createSupervisorResponseCompaction(request, options),
      timeoutReason: "supervisor_response_timeout",
      ...(request.automationOutputContract
        ? { format: automationResponseFormat(request.automationOutputContract) }
        : {}),
      boundSteeringVersion,
      maxRepairAttempts: SUPERVISOR_RESPONSE_MAX_REPAIR_ATTEMPTS,
      validate: request.automationOutputContract
        ? (text) =>
            validateAutomationResponse(request.automationOutputContract!, text)
        : validateSupervisorResponse,
      buildRepairHint: request.automationOutputContract
        ? () =>
            "Return one JSON object matching the requested schema, with no surrounding text."
        : buildSupervisorResponseRepairHint,
    });
    const authored: RootAuthoredResponse = Object.freeze({
      finalResponse,
      memoryCandidates,
    });
    traceSupervisorResponseModelCompleted({
      diagnostic,
      durationMs: Date.now() - startedAt,
      outputLength: authored.finalResponse.length,
    });
    return authored;
  } catch (error: unknown) {
    if (isModelStepSteeringSuperseded(error)) throw error;
    traceSupervisorResponseModelFailed({
      diagnostic,
      durationMs: Date.now() - startedAt,
      errorType:
        error instanceof Error && error.name ? error.name : typeof error,
    });
    throw error;
  }
}

function createSupervisorResponseCompaction(
  request: RequestExecutionScope,
  options: Readonly<{
    call: SupervisorResponseCallIdentity;
    toolResults: RequestToolResultsView;
  }>,
) {
  return createSessionMemoryAwareCompactionController(
    request,
    createPolicyModelStepCompactionController(request, {
      consumer: SUPERVISOR_RESPONSE_MODEL_STEP,
      superFailureOwner: superCompactionFailureOwner(
        request.executionPolicy.authority,
        {
          requestId: request.requestId,
          callId: options.call.callId,
          parentCallId: options.call.parentCallId,
          contractId: "supervisor",
          invocationAttempt: options.call.invocationAttempt,
          sourceRevision: options.toolResults.sourceRevision,
          modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
          phase: "compaction",
          scopeId: `role:supervisor:${options.call.callId}:continuation`,
        },
      ),
      call: {
        roleId: "supervisor",
        callId: options.call.callId,
        objective: request.prompt,
      },
      sourceRevision: options.toolResults.sourceRevision,
      allowedConsumers: Object.freeze([
        SUPERVISOR_DECISION_MODEL_STEP,
        SUPERVISOR_RESPONSE_MODEL_STEP,
      ]),
    }, request.executionPolicy.authority),
  );
}

function validateSupervisorResponse(text: string): RawModelValidationResult {
  const response = text.trim();
  const internalEnvelope = response
    ? isInternalSupervisorEnvelope(response)
    : false;
  if (response && !internalEnvelope) {
    return Object.freeze({ ok: true, value: response });
  }
  return Object.freeze({
    ok: false,
    stage: "raw_response",
    issues: Object.freeze([
      Object.freeze({
        code: internalEnvelope
          ? "supervisor_response_internal_envelope"
          : "supervisor_response_empty",
        path: "response",
        message: internalEnvelope
          ? "Return the user-facing result, not an internal Supervisor routing envelope."
          : "Return one non-empty final response to the user.",
      }),
    ]),
    reason: "invalid_supervisor_response",
  });
}

function isInternalSupervisorEnvelope(text: string): boolean {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return false;
  }
  const record = decoded as Record<string, unknown>;
  const nestedDecision = record.decision;
  const decision =
    nestedDecision &&
    typeof nestedDecision === "object" &&
    !Array.isArray(nestedDecision)
      ? (nestedDecision as Record<string, unknown>)
      : record;
  if (decision.action === "respond") return true;
  if (decision.action === "recall_memory") return true;
  if (decision.action !== "invoke_role") return false;
  if (typeof decision.roleId !== "string") return false;
  return typeof decision.objective === "string";
}
