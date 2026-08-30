import {
  invokeRepairableRawModelStep,
  type RawModelValidationResult,
} from "../../model/invoke-raw-step.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import {
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  EXECUTION_AGENT_RESPONSE_MAX_LENGTH,
  EXECUTION_AGENT_RESPONSE_MODEL_STEP,
} from "./contracts.js";
import { createExecutionAgentCompactionController } from "./compaction.js";
import { createSessionMemoryAwareCompactionController } from "../../context/session-memory/index.js";
import { buildExecutionAgentResponseInput } from "./response-input.js";
import { buildExecutionAgentResponseRepairHint } from "./response-prompt.js";
import { retrieveResponseLongTermMemory } from "../../long-term-memory/response-context.js";
import type { RootAuthoredResponse } from "../../long-term-memory/contracts.js";
import { createPlainRootAuthoredResponse } from "../../orchestration/final-response/authoring-contract.js";
import { invokeRootAuthoredResponse } from "../../orchestration/final-response/invoke.js";

const EXECUTION_AGENT_RESPONSE_MAX_REPAIR_ATTEMPTS = 2;

export async function runExecutionAgentResponse(
  request: RequestExecutionScope,
  options: Readonly<{
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
    steeringSnapshot: RequestSteeringSnapshot;
  }>,
): Promise<string> {
  const authored = await runExecutionAgentAuthoredResponse(request, options);
  return authored.finalResponse;
}

export async function runExecutionAgentAuthoredResponse(
  request: RequestExecutionScope,
  options: Readonly<{
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
    steeringSnapshot: RequestSteeringSnapshot;
  }>,
): Promise<RootAuthoredResponse> {
  const memoryEnabled = request.longTermMemory?.enabled === true;
  const memoryMessage = memoryEnabled
    ? await retrieveResponseLongTermMemory(request, options.steeringSnapshot)
    : undefined;
  const maxResponseChars = Math.min(
    EXECUTION_AGENT_RESPONSE_MAX_LENGTH,
    options.head.policy.limits.maxResponseChars,
  );
  const input = buildExecutionAgentResponseInput(request, {
    ...options,
    ...(memoryEnabled
      ? { memoryAuthoringMaxResponseChars: maxResponseChars }
      : {}),
    ...(memoryMessage ? { longTermMemoryMessage: memoryMessage } : {}),
  });
  const contextCompaction = createSessionMemoryAwareCompactionController(
    request,
    createExecutionAgentCompactionController(request, {
      call: options.call,
      sourceRevision: options.head.revision,
      allowedConsumers: Object.freeze([
        EXECUTION_AGENT_DECISION_MODEL_STEP,
        EXECUTION_AGENT_RESPONSE_MODEL_STEP,
      ]),
    }),
  );
  if (memoryEnabled) {
    return invokeRootAuthoredResponse({
      request,
      modelStep: input.modelStep,
      messages: input.messages,
      contextCompaction,
      timeoutReason: "execution_agent_response_timeout",
      invalidOutputReason: "invalid_execution_agent_authored_response",
      maxResponseChars,
    });
  }
  const output = await invokeRepairableRawModelStep({
    request,
    modelStep: input.modelStep,
    messages: input.messages,
    contextCompaction,
    timeoutReason: "execution_agent_response_timeout",
    maxRepairAttempts: EXECUTION_AGENT_RESPONSE_MAX_REPAIR_ATTEMPTS,
    validate: (text) =>
      validateExecutionAgentResponseText(text, maxResponseChars),
    buildRepairHint: buildExecutionAgentResponseRepairHint,
  });
  return createPlainRootAuthoredResponse(output);
}

function validateExecutionAgentResponseText(
  text: string,
  maxResponseChars: number,
): RawModelValidationResult {
  if (text.trim().length > 0 && text.length <= maxResponseChars) {
    return Object.freeze({ ok: true as const, value: text });
  }
  const empty = text.trim().length === 0;
  return Object.freeze({
    ok: false as const,
    stage: "response_contract",
    issues: Object.freeze([
      Object.freeze({
        code: empty
          ? "execution_agent_response_empty"
          : "execution_agent_response_too_long",
        path: "output",
        message: empty
          ? "Return one complete non-empty user-facing response."
          : `Return the complete response within ${maxResponseChars} characters.`,
      }),
    ]),
    reason: "invalid_execution_agent_response",
  });
}
