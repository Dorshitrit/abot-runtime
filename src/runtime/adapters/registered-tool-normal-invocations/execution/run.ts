import { permitsRequiredToolMode } from "../../../../capabilities/tool-permission-mode.js";
import type {
  RegisteredToolNormalInvocation,
  ToolCall,
} from "../../../../capabilities/tool-types.js";
import { createPreparedNormalInvocation } from "./prepared-execution.js";
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
import { buildToolIntentEventMetadata } from "../shared/event-metadata.js";
import { prepareCompleteInvocationInput } from "../payload/input-preparation.js";
import { rejectNormalInvocation } from "../shared/rejection.js";
import { captureExecutionBinding } from "./execution-binding.js";

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

  if (
    !permitsRequiredToolMode(
      executor.toolPermissionMode,
      source.registration.definition.requiredPermissionMode,
    )
  ) {
    return rejectNormalInvocation(
      "tool_permission_mode_required",
      "The source tool requires a different captured request permission mode.",
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
  if (
    !permitsRequiredToolMode(
      executor.toolPermissionMode,
      target.binding.registration.definition.requiredPermissionMode,
    )
  ) {
    return rejectNormalInvocation(
      "tool_permission_mode_required",
      "The normalized target tool requires a different captured request permission mode.",
    );
  }
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

  const executionBinding = captureExecutionBinding(
    target.binding.registration.adapter,
    normalizedCall.call,
  );
  if (!executionBinding.ok) return executionBinding.rejection;
  const intentMeta = buildToolIntentEventMetadata(
    normalizedCall.call,
    params.input.intent,
    target.binding.registration.definition,
  );
  const eventMeta = executionBinding.metadata
    ? { ...executionBinding.metadata, ...intentMeta }
    : intentMeta;
  const actionFingerprint = createRegisteredToolActionFingerprint({
    contractVersion: target.binding.registration.contract.version,
    operationId: target.binding.operation.operationId,
    call: normalizedCall.call,
    ...(executionBinding.identity
      ? { executionIdentity: executionBinding.identity }
      : {}),
  });
  return createPreparedNormalInvocation({
    executor,
    source,
    target: target.binding,
    call: normalizedCall.call,
    actionFingerprint,
    acceptedControls: preparedInput.controls,
    eventMeta,
    ...(params.input.intent ? { intent: params.input.intent } : {}),
    ...(executionBinding.identity
      ? { executionIdentity: executionBinding.identity }
      : {}),
    ...(executionBinding.metadata
      ? { executionMetadata: executionBinding.metadata }
      : {}),
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
