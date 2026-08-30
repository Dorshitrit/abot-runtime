import {
  invokeRepairableRawModelStep,
  type RawModelValidationResult,
} from "../../model/invoke-raw-step.js";
import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
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
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import { retrieveResponseLongTermMemory } from "../../long-term-memory/response-context.js";
import type { RootAuthoredResponse } from "../../long-term-memory/contracts.js";
import { authorSupervisorMemoryCandidates } from "./memory-authoring.js";

const SUPERVISOR_RESPONSE_MAX_REPAIR_ATTEMPTS = 1;

export async function runSupervisorResponse(
  request: RequestExecutionScope,
  options: Readonly<{
    call: SupervisorResponseCallIdentity;
    toolResults: RequestToolResultsView;
    resume?: SupervisorResponseResumeContext;
  }>,
): Promise<string> {
  const authored = await runSupervisorAuthoredResponse(request, options);
  return authored.finalResponse;
}

export async function runSupervisorAuthoredResponse(
  request: RequestExecutionScope,
  options: Readonly<{
    call: SupervisorResponseCallIdentity;
    toolResults: RequestToolResultsView;
    resume?: SupervisorResponseResumeContext;
    steeringSnapshot?: RequestSteeringSnapshot;
  }>,
): Promise<RootAuthoredResponse> {
  const memoryEnabled = request.longTermMemory?.enabled === true;
  const memoryMessage =
    memoryEnabled && options.steeringSnapshot
      ? await retrieveResponseLongTermMemory(request, options.steeringSnapshot)
      : undefined;
  const inputOptions = {
    ...options,
    ...(memoryMessage ? { longTermMemoryMessage: memoryMessage } : {}),
  };
  const memoryCandidates = memoryEnabled
    ? await authorSupervisorMemoryCandidates({
        request,
        messages: buildSupervisorMemoryAuthoringInput(request, inputOptions)
          .context.messages,
        contextCompaction: createSupervisorResponseCompaction(request, options),
      })
    : Object.freeze([]);
  const input = buildSupervisorResponseInput(request, inputOptions);
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
      maxRepairAttempts: SUPERVISOR_RESPONSE_MAX_REPAIR_ATTEMPTS,
      validate: validateSupervisorResponse,
      buildRepairHint: buildSupervisorResponseRepairHint,
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
    createModelStepCompactionController(request, {
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
    }),
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
  return (
    decision.action === "respond" ||
    (decision.action === "invoke_role" &&
      typeof decision.roleId === "string" &&
      typeof decision.objective === "string")
  );
}
