import type {
  BoundOperation,
  RegisteredToolNormalInvocationPayloadLifecycleInput,
  RegisteredToolNormalInvocationPayloadLifecyclePreparation,
  RegisteredToolNormalInvocationPayloadLifecycleResult,
  RegisteredToolNormalInvocationRejection,
} from "../shared/contracts.js";
import { materializeCall } from "../execution/call-binding.js";
import {
  buildToolExecutorEventMetadata,
  buildToolIntentEventMetadata,
  type ToolEventExecutorIdentity,
} from "../shared/event-metadata.js";
import { rejectNormalInvocation } from "../shared/rejection.js";
import { validatePublicInput } from "./input-preparation.js";

export function emitNormalInvocationPayloadLifecycle(params: {
  operationByHandle: WeakMap<object, BoundOperation>;
  input: RegisteredToolNormalInvocationPayloadLifecycleInput;
  onEvent?(name: string, payload: Record<string, unknown>): void;
}): RegisteredToolNormalInvocationPayloadLifecycleResult {
  const prepared = prepareNormalInvocationPayloadLifecycle(params);
  return prepared.status === "prepared" ? prepared.emit() : prepared;
}

export function prepareNormalInvocationPayloadLifecycle(params: {
  operationByHandle: WeakMap<object, BoundOperation>;
  input: RegisteredToolNormalInvocationPayloadLifecycleInput;
  onEvent?(name: string, payload: Record<string, unknown>): void;
}): RegisteredToolNormalInvocationPayloadLifecyclePreparation {
  const source = params.operationByHandle.get(params.input.handle);
  if (!source) {
    return rejectNormalInvocation(
      "normal_invocation_handle_invalid",
      "The selected ordinary capability is not registered for this request.",
    );
  }
  const payload = source.operation.payload;
  if (!payload) {
    return rejectNormalInvocation(
      "normal_invocation_payload_unavailable",
      "The selected ordinary capability does not declare a raw payload.",
    );
  }
  const lifecycleStage = resolvePayloadLifecycleStage(source, params.input);
  if (!lifecycleStage.ok) {
    return lifecycleStage.rejection;
  }
  const sourceInput = validatePublicInput(source, params.input.controls);
  if (!sourceInput.ok) {
    return rejectNormalInvocation(
      "normal_invocation_input_invalid",
      sourceInput.issue,
    );
  }
  const eventCall = materializeCall(source, sourceInput.value, undefined);
  const eventMeta = buildToolIntentEventMetadata(
    eventCall,
    params.input.intent,
    source.registration.definition,
  );
  const base = {
    tool: source.registration.toolName,
    outputParam: lifecycleStage.stage.outputParam,
    payloadStage: lifecycleStage.stage.index,
    payloadStageCount: lifecycleStage.stage.count,
    ...(eventMeta ? { meta: eventMeta } : {}),
  };
  const event = materializePayloadLifecycleEvent(params.input, base);
  return Object.freeze({
    status: "prepared" as const,
    emit: (
      executionId?: string,
      executorIdentity?: ToolEventExecutorIdentity,
    ) => {
      params.onEvent?.(event.name, {
        ...event.payload,
        ...buildToolExecutorEventMetadata(executorIdentity),
        ...(executionId ? { executionId } : {}),
      });
      return Object.freeze({ status: "emitted" as const });
    },
  });
}

function materializePayloadLifecycleEvent(
  input: RegisteredToolNormalInvocationPayloadLifecycleInput,
  base: Readonly<Record<string, unknown>>,
): Readonly<{ name: string; payload: Record<string, unknown> }> {
  switch (input.phase) {
    case "started":
      return Object.freeze({ name: "tool.payload.started", payload: base });
    case "completed":
      return Object.freeze({
        name: "tool.payload.completed",
        payload: { ...base, ok: true },
      });
    case "failed":
      return Object.freeze({
        name: "tool.payload.failed",
        payload: {
          ...base,
          ...(input.errorCode ? { error: input.errorCode } : {}),
        },
      });
  }
}

function resolvePayloadLifecycleStage(
  source: BoundOperation,
  input: Pick<
    RegisteredToolNormalInvocationPayloadLifecycleInput,
    "payloadStage" | "payloadStageCount" | "outputParam"
  >,
):
  | Readonly<{
      ok: true;
      stage: Readonly<{ index: number; count: number; outputParam: string }>;
    }>
  | Readonly<{
      ok: false;
      rejection: RegisteredToolNormalInvocationRejection;
    }> {
  const plan = source.stagedPayloadPlan;
  if (!plan) {
    const outputParam = source.operation.payload?.param;
    if (!outputParam) {
      return {
        ok: false,
        rejection: rejectNormalInvocation(
          "normal_invocation_payload_unavailable",
          "The selected ordinary capability does not declare a raw payload.",
        ),
      };
    }
    if (
      (input.payloadStage !== undefined && input.payloadStage !== 1) ||
      (input.payloadStageCount !== undefined &&
        input.payloadStageCount !== 1) ||
      (input.outputParam !== undefined && input.outputParam !== outputParam)
    ) {
      return invalidPayloadStage();
    }
    return {
      ok: true,
      stage: Object.freeze({ index: 1, count: 1, outputParam }),
    };
  }

  if (
    !Number.isSafeInteger(input.payloadStage) ||
    !Number.isSafeInteger(input.payloadStageCount) ||
    input.payloadStageCount !== plan.stages.length ||
    typeof input.outputParam !== "string"
  ) {
    return invalidPayloadStage();
  }
  const stage = plan.stages[(input.payloadStage as number) - 1];
  if (
    !stage ||
    input.payloadStage! < 1 ||
    input.outputParam !== stage.outputParam
  ) {
    return invalidPayloadStage();
  }
  return {
    ok: true,
    stage: Object.freeze({
      index: input.payloadStage!,
      count: input.payloadStageCount!,
      outputParam: stage.outputParam,
    }),
  };
}

function invalidPayloadStage(): Readonly<{
  ok: false;
  rejection: RegisteredToolNormalInvocationRejection;
}> {
  return {
    ok: false,
    rejection: rejectNormalInvocation(
      "normal_invocation_payload_stage_invalid",
      "The selected ordinary capability payload stage is invalid.",
    ),
  };
}
