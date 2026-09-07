import {
  buildToolCompletedEventActions,
  buildToolCompletedEventMetadata,
  buildToolLifecycleEventCopy,
} from "../../../../capabilities/tool-event-metadata.js";
import type {
  RegisteredToolNormalInvocation,
  ToolCall,
} from "../../../../capabilities/tool-types.js";
import { requestNormalInvocationApproval } from "./approval.js";
import { createPreparedInvocationRejectionEmitter } from "./rejection-event.js";
import {
  captureToolCall,
  materializeCall,
  resolveExactTargetOperation,
  validateCompleteCall,
} from "./call-binding.js";
import type {
  BoundOperation,
  RegisteredToolNormalInvocationExecutionInput,
  RegisteredToolNormalInvocationExecutorParams,
  RegisteredToolNormalInvocationPreparation,
  RegisteredToolNormalInvocationPreparationInput,
  RegisteredToolNormalInvocationResult,
} from "../shared/contracts.js";
import { createRegisteredToolActionFingerprint } from "../shared/action-fingerprint.js";
import {
  buildToolExecutorEventMetadata,
  buildToolIntentEventMetadata,
  type ToolEventExecutorIdentity,
} from "../shared/event-metadata.js";
import { prepareCompleteInvocationInput } from "../payload/input-preparation.js";
import { rejectNormalInvocation } from "../shared/rejection.js";

export async function executeNormalInvocation(params: {
  executor: RegisteredToolNormalInvocationExecutorParams;
  registrations: readonly RegisteredToolNormalInvocation[];
  operationByHandle: WeakMap<object, BoundOperation>;
  input: RegisteredToolNormalInvocationExecutionInput;
}): Promise<RegisteredToolNormalInvocationResult> {
  const prepared = prepareNormalInvocation(params);
  return prepared.status === "prepared"
    ? prepared.execute()
    : Promise.resolve(prepared);
}

export function prepareNormalInvocation(params: {
  executor: RegisteredToolNormalInvocationExecutorParams;
  registrations: readonly RegisteredToolNormalInvocation[];
  operationByHandle: WeakMap<object, BoundOperation>;
  input: RegisteredToolNormalInvocationPreparationInput;
}): RegisteredToolNormalInvocationPreparation {
  const executor = params.executor;
  executor.abortSignal.throwIfAborted();
  const source = params.operationByHandle.get(params.input.handle);
  if (!source) {
    return rejectNormalInvocation(
      "normal_invocation_handle_invalid",
      "The selected ordinary capability is not registered for this request.",
    );
  }

  const preparedInput = prepareCompleteInvocationInput(source, params.input);
  if (!preparedInput.ok) return preparedInput.rejection;

  const sourceCall = materializeCall(
    source,
    preparedInput.controls,
    preparedInput.payload,
  );
  const sourceValidation = validateCompleteCall({
    adapter: source.registration.adapter,
    call: sourceCall,
    rejectedCode: "normal_invocation_call_invalid",
    failedCode: "normal_invocation_call_validation_failed",
    failedMessage:
      "The registered source tool adapter could not validate the complete call.",
  });
  if (!sourceValidation.ok) return sourceValidation.rejection;

  const normalizedCall = normalizeToolCall(source, sourceCall);
  if (!normalizedCall.ok) return normalizedCall.rejection;

  const target = resolveExactTargetOperation(
    params.registrations,
    normalizedCall.call,
  );
  if (!target.ok) return target.rejection;
  const targetValidation = validateCompleteCall({
    adapter: target.binding.registration.adapter,
    call: normalizedCall.call,
    rejectedCode: "normal_invocation_target_call_invalid",
    failedCode: "normal_invocation_target_call_validation_failed",
    failedMessage:
      "The registered target tool adapter could not validate the normalized call.",
  });
  if (!targetValidation.ok) return targetValidation.rejection;
  if (target.binding.operation.effect !== source.operation.effect) {
    return rejectNormalInvocation(
      "normal_invocation_effect_changed",
      "A normalized ordinary invocation cannot change its declared execution effect.",
    );
  }

  const eventMeta = buildToolIntentEventMetadata(
    normalizedCall.call,
    params.input.intent,
    target.binding.registration.definition,
  );
  const actionFingerprint = createRegisteredToolActionFingerprint({
    contractVersion: target.binding.registration.contract.version,
    operationId: target.binding.operation.operationId,
    call: normalizedCall.call,
  });
  return Object.freeze({
    status: "prepared" as const,
    actionFingerprint,
    acceptedControls: preparedInput.controls,
    emitRejection: createPreparedInvocationRejectionEmitter({
      tool: source.registration.toolName,
      eventMeta,
      onEvent: executor.onEvent,
    }),
    execute: (
      executionId?: string,
      executorIdentity?: ToolEventExecutorIdentity,
    ) =>
      executePreparedNormalInvocation({
        ...(executionId ? { executionId } : {}),
        ...(executorIdentity ? { executorIdentity } : {}),
        executor,
        source,
        target: target.binding,
        call: normalizedCall.call,
        eventMeta,
        input: params.input,
      }),
  });
}

async function executePreparedNormalInvocation(params: {
  executionId?: string;
  executorIdentity?: ToolEventExecutorIdentity;
  executor: RegisteredToolNormalInvocationExecutorParams;
  source: BoundOperation;
  target: BoundOperation;
  call: ToolCall;
  eventMeta: ReturnType<typeof buildToolIntentEventMetadata>;
  input: RegisteredToolNormalInvocationPreparationInput;
}): Promise<RegisteredToolNormalInvocationResult> {
  const approval = await requestNormalInvocationApproval({
    ...(params.executorIdentity
      ? { executorIdentity: params.executorIdentity }
      : {}),
    ...(params.executionId ? { executionId: params.executionId } : {}),
    requestId: params.executor.requestId,
    abortSignal: params.executor.abortSignal,
    toolPermissionMode: params.executor.toolPermissionMode,
    ...(params.executor.toolApprovalController
      ? { toolApprovalController: params.executor.toolApprovalController }
      : {}),
    nextApprovalId: params.executor.nextApprovalId,
    ...(params.executor.onEvent ? { onEvent: params.executor.onEvent } : {}),
    call: params.call,
    ...(params.eventMeta ? { eventMeta: params.eventMeta } : {}),
    force:
      params.source.operation.approval === "always" ||
      params.target.operation.approval === "always",
  });
  if (!approval.ok) return approval.rejection;
  params.executor.abortSignal.throwIfAborted();

  const startedCopy = buildToolLifecycleEventCopy(
    params.target.registration.definition,
    "started",
  );
  params.executor.onEvent?.("tool.started", {
    ...buildToolExecutorEventMetadata(params.executorIdentity),
    ...(params.executionId ? { executionId: params.executionId } : {}),
    tool: params.call.tool,
    ...(params.input.intent
      ? { intent: params.input.intent, intentSource: "model" }
      : {}),
    ...(params.eventMeta ? { meta: params.eventMeta } : {}),
    ...(startedCopy ?? {}),
  });
  const result = await params.executor.toolRegistry.execute(params.call, {
    abortSignal: params.executor.abortSignal,
    ...(params.executor.sharedState
      ? { sharedState: params.executor.sharedState }
      : {}),
  });
  const completionActions = Object.freeze(
    buildToolCompletedEventActions(
      params.call,
      result,
      params.target.registration.definition,
    ).map((action) => Object.freeze({ ...action })),
  );
  const completedMeta = buildToolCompletedEventMetadata(
    params.call,
    result,
    params.target.registration.definition,
  );
  const completedCopy = buildToolLifecycleEventCopy(
    params.target.registration.definition,
    result.ok ? "completed" : "failed",
  );
  params.executor.onEvent?.("tool.completed", {
    ...buildToolExecutorEventMetadata(params.executorIdentity),
    ...(params.executionId ? { executionId: params.executionId } : {}),
    tool: params.source.registration.toolName,
    ok: result.ok,
    actions: completionActions,
    ...(completedMeta ? { meta: completedMeta } : {}),
    ...(completedCopy ?? {}),
  });
  return Object.freeze({
    status: "executed" as const,
    effect: params.target.operation.effect,
    result,
    completionActions,
  });
}

function normalizeToolCall(
  source: BoundOperation,
  sourceCall: ToolCall,
):
  | Readonly<{ ok: true; call: ToolCall }>
  | Readonly<{
      ok: false;
      rejection: ReturnType<typeof rejectNormalInvocation>;
    }> {
  try {
    const normalized = source.registration.adapter?.normalizeCall
      ? source.registration.adapter.normalizeCall(sourceCall)
      : sourceCall;
    const captured = captureToolCall(normalized);
    if (!captured) {
      return {
        ok: false,
        rejection: rejectNormalInvocation(
          "normal_invocation_normalization_invalid",
          "The registered tool adapter returned an invalid normalized call.",
        ),
      };
    }
    return Object.freeze({ ok: true as const, call: captured });
  } catch {
    return {
      ok: false,
      rejection: rejectNormalInvocation(
        "normal_invocation_normalization_failed",
        "The registered tool adapter could not normalize the selected call.",
      ),
    };
  }
}
