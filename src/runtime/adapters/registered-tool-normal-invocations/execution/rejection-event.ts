import type {
  BoundOperation,
  RegisteredToolNormalInvocationExecutor,
  RegisteredToolNormalInvocationExecutorParams,
  RegisteredToolPreparedNormalInvocation,
} from "../shared/contracts.js";
import {
  buildToolExecutorEventMetadata,
  buildToolIntentEventMetadata,
} from "../shared/event-metadata.js";

/** Projects source controls only; rejected calls are never prepared again. */
export function prepareNormalInvocationRejectionEvent(params: {
  operationByHandle: WeakMap<object, BoundOperation>;
  input: Parameters<
    RegisteredToolNormalInvocationExecutor["prepareRejectionEvent"]
  >[0];
  onEvent: RegisteredToolNormalInvocationExecutorParams["onEvent"];
}): ReturnType<
  RegisteredToolNormalInvocationExecutor["prepareRejectionEvent"]
> {
  const source = params.operationByHandle.get(params.input.handle);
  if (!source) return undefined;
  return createPreparedInvocationRejectionEmitter({
    tool: source.registration.toolName,
    eventMeta: buildToolIntentEventMetadata(
      { tool: source.registration.toolName, params: params.input.controls },
      params.input.intent,
      source.registration.definition,
    ),
    onEvent: params.onEvent,
  });
}

/** Reports an admitted invocation rejected before the external tool ran. */
export function createPreparedInvocationRejectionEmitter(params: {
  tool: string;
  eventMeta: Record<string, unknown> | undefined;
  onEvent: RegisteredToolNormalInvocationExecutorParams["onEvent"];
}): RegisteredToolPreparedNormalInvocation["emitRejection"] {
  return ({ executionId, executorIdentity, errorCode }) => {
    params.onEvent?.("tool.failed", {
      ...buildToolExecutorEventMetadata(executorIdentity),
      executionId,
      tool: params.tool,
      stage: "before_external_execution",
      error: errorCode,
      ...(params.eventMeta ? { meta: params.eventMeta } : {}),
    });
  };
}
