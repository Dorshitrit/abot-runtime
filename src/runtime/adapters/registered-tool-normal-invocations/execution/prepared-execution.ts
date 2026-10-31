import {
  resolveApprovalBeforeWorkerDispatch, workerDispatchRejection,
} from "./steering-admission.js";
import type { WorkerCapabilityExecutionFreshness } from "../../../orchestration/worker-capabilities/contracts.js";
import type { CapabilityResultReference } from "../../../orchestration/capability-adapters/result.js";
import {
  createRegisteredToolResultBudget,
  assertRegisteredToolResultMetadataFits,
} from "./result-budget.js";
import { randomUUID } from "node:crypto";
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
import { rejectNormalInvocation } from "../shared/rejection.js";
import { requiresRegisteredToolActionApproval } from "./approval.js";
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
  requiresApproval?: boolean;
  executionMetadata?: Readonly<Record<string, unknown>>;
  restoredApprovalRequest?: ToolApprovalRequest;
}): RegisteredToolPreparedNormalInvocation {
  // Keep an already-recorded approval pending across upgrades; new core reads skip it.
  const requiresApproval = params.requiresApproval === true ||
    params.restoredApprovalRequest !== undefined ||
    requiresRegisteredToolActionApproval(
      params.executor.toolPermissionMode, params.source, params.target,
    );
  const approvalRequest = requiresApproval
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
      ...(params.requiresApproval === true ? { requiresApproval: true } : {}),
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
      selectedReferences?: readonly CapabilityResultReference[],
      executionFreshness?: WorkerCapabilityExecutionFreshness,
    ) =>
      executePreparedNormalInvocation({
        ...params,
        selectedReferences,
        ...(executionFreshness ? { executionFreshness } : {}),
        ...(approvalRequest ? { approvalRequest } : {}),
        ...(decision ? { decision, decisionRecorded } : {}),
        ...(executionId ? { executionId } : {}),
        ...(executorIdentity ? { executorIdentity } : {}),
      }),
  });
}

async function executePreparedNormalInvocation(params: {
  executionFreshness?: WorkerCapabilityExecutionFreshness;
  selectedReferences?: readonly CapabilityResultReference[];
  executionId?: string;
  executorIdentity?: ToolEventExecutorIdentity;
  executor: RegisteredToolNormalInvocationExecutorParams;
  source: BoundOperation;
  target: BoundOperation;
  call: ToolCall;
  actionFingerprint: string;
  eventMeta?: ReturnType<typeof buildToolIntentEventMetadata>;
  executionMetadata?: Readonly<Record<string, unknown>>;
  intent?: string;
  executionIdentity?: string;
  requiresApproval?: boolean;
  approvalRequest?: ToolApprovalRequest;
  decision?: ToolApprovalDecision;
  decisionRecorded?: boolean;
}): Promise<RegisteredToolNormalInvocationResult> {
  const resultBudget = createRegisteredToolResultBudget({
    call: params.call,
    definition: params.target.registration.definition,
    selectedReferences: params.selectedReferences,
  });
  assertRegisteredToolResultMetadataFits(resultBudget);
  const approval = await resolveApprovalBeforeWorkerDispatch({
    requiresExplicitApproval: params.requiresApproval === true,
    requiredByOperationPolicy: params.requiresApproval === true ||
      params.approvalRequest !== undefined ||
      requiresRegisteredToolActionApproval(
        params.executor.toolPermissionMode, params.source, params.target,
      ),
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
  }, params.executionFreshness);
  if (!approval.ok) return approval.rejection;
  params.executor.abortSignal.throwIfAborted();
  const effectExecutionId = params.executionId ?? randomUUID();
  const identity = (binding: BoundOperation) => ({
    toolName: binding.registration.toolName,
    operationId: binding.operation.operationId,
    contractVersion: binding.registration.contract.version,
  });
  const effectAdmission = await params.executor.effectPersistence?.beforeEffect(
    {
      executionId: effectExecutionId,
      actionFingerprint: params.actionFingerprint,
      source: identity(params.source),
      target: identity(params.target),
      effect: params.target.operation.effect,
    },
  );
  const abortedBeforeDispatch = params.executor.abortSignal.aborted;
  if (abortedBeforeDispatch) {
    await params.executor.effectPersistence?.afterEffect({
      executionId: effectExecutionId,
      outcome: rejectNormalInvocation(
        "request_aborted",
        "The operation was stopped before it began.",
      ),
    });
  }
  params.executor.abortSignal.throwIfAborted();

  const steeringRejection = workerDispatchRejection(params.executionFreshness);
  if (steeringRejection) {
    await params.executor.effectPersistence?.afterEffect({
      executionId: effectExecutionId, outcome: steeringRejection,
    });
    return steeringRejection;
  }

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
  let result;
  try {
    result = await executeWithToolResources({
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
        executionAuthority: Object.freeze({
          toolPermissionMode: params.executor.toolPermissionMode,
          ...(params.executionIdentity
            ? { executionIdentity: params.executionIdentity }
            : {}),
        }),
        abortSignal: params.executor.abortSignal,
        resultBudget,
        ...(effectAdmission ? { trustedEffectAdmission: effectAdmission } : {}),
        reportFileOutput: fileOutputPresentation.report,
        ...(params.executor.sharedState
          ? { sharedState: params.executor.sharedState }
          : {}),
      },
    });
  } catch (error) {
    await params.executor.effectPersistence?.afterEffect({
      executionId: effectExecutionId,
      outcome: {
        status: "uncertain",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
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
  const settled = Object.freeze({
    status: "executed" as const,
    effect: params.target.operation.effect,
    result,
    completionActions,
  });
  await params.executor.effectPersistence?.afterEffect({
    executionId: effectExecutionId,
    outcome: settled,
  });
  params.executor.onEvent?.("tool.completed", {
    ...buildToolExecutorEventMetadata(params.executorIdentity),
    ...(params.executionId ? { executionId: params.executionId } : {}),
    tool: params.source.registration.toolName,
    ok: result.ok,
    actions: completionActions,
    ...(completedEventMeta ? { meta: completedEventMeta } : {}),
    ...(completedCopy ?? {}),
  });
  return settled;
}
