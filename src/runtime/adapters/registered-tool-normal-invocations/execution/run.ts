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
  RegisteredToolNormalInvocationResult,
} from "../shared/contracts.js";
import { buildToolIntentEventMetadata } from "../shared/event-metadata.js";
import { prepareCompleteInvocationInput } from "../payload/input-preparation.js";
import { rejectNormalInvocation } from "../shared/rejection.js";

export async function executeNormalInvocation(params: {
  executor: RegisteredToolNormalInvocationExecutorParams;
  registrations: readonly RegisteredToolNormalInvocation[];
  operationByHandle: WeakMap<object, BoundOperation>;
  input: RegisteredToolNormalInvocationExecutionInput;
}): Promise<RegisteredToolNormalInvocationResult> {
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
  const approval = await requestNormalInvocationApproval({
    requestId: executor.requestId,
    abortSignal: executor.abortSignal,
    toolPermissionMode: executor.toolPermissionMode,
    ...(executor.toolApprovalController
      ? { toolApprovalController: executor.toolApprovalController }
      : {}),
    nextApprovalId: executor.nextApprovalId,
    ...(executor.onEvent ? { onEvent: executor.onEvent } : {}),
    call: normalizedCall.call,
    ...(eventMeta ? { eventMeta } : {}),
    force:
      source.operation.approval === "always" ||
      target.binding.operation.approval === "always",
  });
  if (!approval.ok) return approval.rejection;
  executor.abortSignal.throwIfAborted();

  const startedCopy = buildToolLifecycleEventCopy(
    target.binding.registration.definition,
    "started",
  );
  executor.onEvent?.("tool.started", {
    tool: normalizedCall.call.tool,
    ...(params.input.intent
      ? { intent: params.input.intent, intentSource: "model" }
      : {}),
    ...(eventMeta ? { meta: eventMeta } : {}),
    ...(startedCopy ?? {}),
  });
  const result = await executor.toolRegistry.execute(normalizedCall.call, {
    abortSignal: executor.abortSignal,
    ...(executor.sharedState ? { sharedState: executor.sharedState } : {}),
  });
  const completionActions = Object.freeze(
    buildToolCompletedEventActions(
      normalizedCall.call,
      result,
      target.binding.registration.definition,
    ).map((action) => Object.freeze({ ...action })),
  );
  const completedMeta = buildToolCompletedEventMetadata(
    normalizedCall.call,
    result,
    target.binding.registration.definition,
  );
  const completedCopy = buildToolLifecycleEventCopy(
    target.binding.registration.definition,
    result.ok ? "completed" : "failed",
  );
  executor.onEvent?.("tool.completed", {
    tool: source.registration.toolName,
    ok: result.ok,
    actions: completionActions,
    ...(completedMeta ? { meta: completedMeta } : {}),
    ...(completedCopy ?? {}),
  });
  return Object.freeze({
    status: "executed" as const,
    effect: target.binding.operation.effect,
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
