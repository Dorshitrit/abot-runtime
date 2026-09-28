import { requiresToolActionApproval } from "../../../../capabilities/tool-permission-mode.js";
import {
  buildToolCompletedEventActions,
  buildToolCompletedEventMetadata,
  buildToolLifecycleEventCopy,
} from "../../../../capabilities/tool-event-metadata.js";
import type { ToolCall } from "../../../../capabilities/tool-types.js";
import type {
  ToolApprovalRequest,
  ToolApprovalDecision,
} from "../../../ports.js";
import type { BoundApprovalDecision } from "../../../orchestration/worker-capabilities/approval-contracts.js";
import type {
  BoundOperation,
  RegisteredToolNormalInvocationExecutorParams,
  RegisteredToolNormalInvocationResult,
  RegisteredToolPreparedNormalInvocation,
} from "../shared/contracts.js";
import {
  buildToolExecutorEventMetadata,
  buildToolIntentEventMetadata,
  type ToolEventExecutorIdentity,
} from "../shared/event-metadata.js";
import { requestNormalInvocationApproval } from "./approval.js";
import { createPreparedInvocationRejectionEmitter } from "./rejection-event.js";
import { createFileOutputPresentation } from "./file-output-presentation.js";
import { executeWithToolResources } from "./tool-media-execution.js";

export function createPreparedNormalInvocation(params: {
  executor: RegisteredToolNormalInvocationExecutorParams;
  source: BoundOperation;
  target: BoundOperation;
  call: ToolCall;
  actionFingerprint: string;
  acceptedControls: Readonly<Record<string, unknown>>;
  intent?: string;
  eventMeta?: Record<string, unknown>;
  executionIdentity?: string;
  executionMetadata?: Readonly<Record<string, unknown>>;
  restoredApprovalRequest?: ToolApprovalRequest;
}): RegisteredToolPreparedNormalInvocation {
  const force =
    params.source.operation.approval === "always" ||
    params.target.operation.approval === "always";
  const approvalRequest = requiresToolActionApproval(
    params.executor.toolPermissionMode,
    force,
  )
    ? Object.freeze({
        ...(params.restoredApprovalRequest ?? {
          requestId: params.executor.requestId,
          approvalId: params.executor.nextApprovalId(),
          call: params.call,
          ...(params.eventMeta ? { meta: params.eventMeta } : {}),
        }),
        call: params.call,
      })
    : undefined;
  const identity = (binding: BoundOperation) => ({
    tool: binding.registration.toolName,
    operationId: binding.operation.operationId,
    contractVersion: binding.registration.contract.version,
  });
  const snapshot = Object.freeze(
    structuredClone({
      kind: "registered_tool_normal_invocation_v1",
      source: identity(params.source),
      target: identity(params.target),
      call: params.call,
      acceptedControls: params.acceptedControls,
      actionFingerprint: params.actionFingerprint,
      toolPermissionMode: params.executor.toolPermissionMode,
      ...(params.intent ? { intent: params.intent } : {}),
      ...(params.eventMeta ? { eventMeta: params.eventMeta } : {}),
      ...(params.executionIdentity
        ? { executionIdentity: params.executionIdentity }
        : {}),
      ...(approvalRequest ? { approvalRequest } : {}),
    }),
  );
  let decision: ToolApprovalDecision | undefined;
  let decisionRecorded = false;
  return Object.freeze({
    status: "prepared" as const,
    actionFingerprint: params.actionFingerprint,
    acceptedControls: params.acceptedControls,
    snapshot,
    ...(approvalRequest ? { approvalRequest } : {}),
    applyApprovalDecision(bound: BoundApprovalDecision) {
      if (
        !approvalRequest ||
        bound.approvalId !== approvalRequest.approvalId ||
        bound.actionFingerprint !== params.actionFingerprint ||
        decision
      )
        throw new Error("prepared_approval_decision_mismatch");
      decision = Object.freeze({ ...bound.decision });
      decisionRecorded = bound.recorded === true;
    },
    emitRejection: createPreparedInvocationRejectionEmitter({
      tool: params.source.registration.toolName,
      eventMeta: params.eventMeta,
      onEvent: params.executor.onEvent,
    }),
    execute: (
      executionId?: string,
      executorIdentity?: ToolEventExecutorIdentity,
    ) =>
      executePreparedNormalInvocation({
        ...params,
        ...(approvalRequest ? { approvalRequest } : {}),
        ...(decision ? { decision, decisionRecorded } : {}),
        ...(executionId ? { executionId } : {}),
        ...(executorIdentity ? { executorIdentity } : {}),
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
  eventMeta?: ReturnType<typeof buildToolIntentEventMetadata>;
  executionMetadata?: Readonly<Record<string, unknown>>;
  intent?: string;
  approvalRequest?: ToolApprovalRequest;
  decision?: ToolApprovalDecision;
  decisionRecorded?: boolean;
}): Promise<RegisteredToolNormalInvocationResult> {
  const approval = await requestNormalInvocationApproval({
    ...(params.approvalRequest
      ? { preparedRequest: params.approvalRequest }
      : {}),
    ...(params.decision
      ? { decision: params.decision, decisionRecorded: params.decisionRecorded }
      : {}),
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
    ...(params.intent ? { intent: params.intent, intentSource: "model" } : {}),
    ...(params.eventMeta ? { meta: params.eventMeta } : {}),
    ...(startedCopy ?? {}),
  });
  const fileOutputPresentation = createFileOutputPresentation(
    params.executor.sharedState?.runtimePaths,
  );
  const result = await executeWithToolResources({
    registry: params.executor.toolRegistry,
    call: params.call,
    resources: params.executor.toolResources,
    ...(params.executionId && params.executorIdentity
      ? {
          owner: {
            executionId: params.executionId,
            callId: params.executorIdentity.callId,
          },
        }
      : {}),
    options: {
      abortSignal: params.executor.abortSignal,
      reportFileOutput: fileOutputPresentation.report,
      ...(params.executor.sharedState
        ? { sharedState: params.executor.sharedState }
        : {}),
    },
  });
  const completionActions = Object.freeze(
    buildToolCompletedEventActions(
      params.call,
      result,
      params.target.registration.definition,
    ).map((action) => Object.freeze({ ...action })),
  );
  const completedMeta = fileOutputPresentation.finish(
    result,
    buildToolCompletedEventMetadata(
      params.call,
      result,
      params.target.registration.definition,
    ),
    params.target.operation.effect,
  );
  const completedCopy = buildToolLifecycleEventCopy(
    params.target.registration.definition,
    result.ok ? "completed" : "failed",
  );
  const completedEventMeta = params.executionMetadata
    ? { ...completedMeta, ...params.executionMetadata }
    : completedMeta;
  params.executor.onEvent?.("tool.completed", {
    ...buildToolExecutorEventMetadata(params.executorIdentity),
    ...(params.executionId ? { executionId: params.executionId } : {}),
    tool: params.source.registration.toolName,
    ok: result.ok,
    actions: completionActions,
    ...(completedEventMeta ? { meta: completedEventMeta } : {}),
    ...(completedCopy ?? {}),
  });
  return Object.freeze({
    status: "executed" as const,
    effect: params.target.operation.effect,
    result,
    completionActions,
  });
}
