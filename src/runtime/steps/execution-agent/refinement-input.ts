import { buildRuntimeFilesystemScopeMessage } from "../../context/runtime-filesystem-scope.js";
import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  assessRequestMessagesBudget,
  projectRequestContext,
} from "../../context/request-context.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import { buildRequestTemporalContextMessage } from "../../context/request-temporal-context.js";
import {
  buildRequestSourceMessage,
  projectRequestSource,
} from "../../context/request-source.js";
import { buildSessionArtifactPathsMessage } from "../../context/session-artifact-paths.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  CAPABILITY_CONTROLS_MODEL_STEP,
  type CapabilityControls,
  type CapabilityControlsPartition,
  type CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { appendRequestSteeringContext } from "../../request/request-steering-context.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import type { ExecutionAgentCapabilityInvocation } from "./contracts.js";
import { projectSelectedControlsEvidence } from "./controls-evidence.js";
import { buildExecutionRefinementStateMessage } from "./state-context.js";

export type PendingExecutionRefinement = Readonly<{
  index: number;
  invocation: ExecutionAgentCapabilityInvocation;
  descriptor: CapabilityDescriptor;
  partition: CapabilityControlsPartition;
  selectionControls: CapabilityControls;
  guidance: string;
}>;

export function executionRefinementSlotId(index: number): string {
  return `invocation_${index + 1}`;
}

export function buildExecutionControlsRefinementInput(
  request: RequestExecutionScope,
  options: Readonly<{
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
    workingDirectory?: string;
    steeringSnapshot: RequestSteeringSnapshot;
    eligibleSessionArtifactPaths: readonly string[];
    pending: readonly PendingExecutionRefinement[];
    format: ModelGatewayJsonSchemaFormat;
    instructions: string;
  }>,
) {
  const { instructions, format } = options;
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: CAPABILITY_CONTROLS_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const callId = `execution-refinement-${options.head.revision + 1}`;
  const requestSource = projectRequestSource({
    requestId: request.requestId,
    prompt: request.prompt,
    modelStep: CAPABILITY_CONTROLS_MODEL_STEP,
    callId,
    historyMessages: request.historyMessages,
  });
  const evidence = projectSelectedControlsEvidence({
    requestId: request.requestId,
    head: options.head,
    call: options.call,
    steering: options.steeringSnapshot,
    compaction: {
      prompt: request.prompt,
      store: request.contextCompactionStore,
    },
    workingDirectory: options.workingDirectory,
    slots: options.pending.map(
      ({
        index,
        invocation,
        descriptor,
        partition,
        selectionControls,
        guidance,
      }) => ({
        slot: executionRefinementSlotId(index),
        capabilityId: descriptor.capabilityId,
        ...(invocation.operationObjective
          ? { operationObjective: invocation.operationObjective }
          : {}),
        selectionControls,
        remainingControls: partition.remainingSchema,
        ...(invocation.controlsEvidenceExecutionIds
          ? {
              controlsEvidenceExecutionIds:
                invocation.controlsEvidenceExecutionIds,
            }
          : {}),
        guidance,
      }),
    ),
  });
  const previous = request.contextCompactionStore?.get(evidence.scopeId);
  if (previous && previous.sourceRevision > options.head.revision) {
    throw new Error("context_compaction_checkpoint_revision_invalid");
  }
  const assignment = JSON.stringify({
    kind: "runtime_execution_capability_refinement_v1",
    authority: "runtime_state",
    stateRevision: options.head.revision,
    requestSourceRef: requestSource.sourceRef,
    workingDirectory:
      options.workingDirectory ?? options.call.workingDirectory ?? null,
    invocations: evidence.slots.map(({ guidance: _guidance, ...slot }) => slot),
  });
  const continuationMessages = evidence.messages;
  const filesystemMessage = buildRuntimeFilesystemScopeMessage({
    scope: request.workerCapabilities.filesystemScope,
    workingDirectory: options.workingDirectory ?? options.call.workingDirectory,
    capabilities: options.pending.map(({ descriptor }) => descriptor),
  });
  const baseReferenceMessages = Object.freeze([
    ...(filesystemMessage ? [filesystemMessage] : []),
    ...(request.temporalContext
      ? [buildRequestTemporalContextMessage(request.temporalContext)]
      : []),
    buildRequestSourceMessage(requestSource),
    buildExecutionRefinementStateMessage(options.head, options.call),
    ...appendRequestSteeringContext([], options.steeringSnapshot),
  ]);
  const currentMessage = {
    role: "user" as const,
    content: assignment,
    ...(request.attachments ? { attachments: request.attachments } : {}),
  };
  const sessionArtifactPathProjection = buildSessionArtifactPathsMessage({
    targets: options.eligibleSessionArtifactPaths,
    availableTargetCount: request.sessionArtifactPaths?.length ?? 0,
    applicable: options.pending.some(({ descriptor, partition }) =>
      (descriptor.runtimePathControlIds ?? []).some((controlId) =>
        Object.hasOwn(partition.remainingSchema.properties, controlId),
      ),
    ),
    maxTargets: 8,
    fits: (message) =>
      assessRequestMessagesBudget({
        messages: [
          { role: "system", content: instructions },
          message,
          ...baseReferenceMessages,
          currentMessage,
          ...continuationMessages,
        ],
        format,
        budget,
      }).fits,
  });
  const context = projectRequestContext({
    instructions,
    format,
    historyMessages: [],
    prompt: assignment,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    referenceMessages: [
      ...(sessionArtifactPathProjection
        ? [sessionArtifactPathProjection.message]
        : []),
      ...baseReferenceMessages,
    ],
    ...(continuationMessages.length > 0 ? { continuationMessages } : {}),
    budget,
    diagnostic: {
      requestId: request.requestId,
      modelStep: CAPABILITY_CONTROLS_MODEL_STEP,
      callId,
    },
    onEvent: request.onEvent,
    deferCompactionFailure: true,
  });
  return Object.freeze({
    messages: context.messages,
    contextCompaction: createModelStepCompactionController(request, {
      call: {
        roleId: options.call.roleId,
        callId: options.call.callId,
        objective: evidence.preservationObjective,
      },
      sourceRevision: options.head.revision,
      scopeId: evidence.scopeId,
      consumer: CAPABILITY_CONTROLS_MODEL_STEP,
      hasVerifiedCompactedEvidence: evidence.hasVerifiedCompactedEvidence,
      allowedConsumers: Object.freeze([CAPABILITY_CONTROLS_MODEL_STEP]),
    }),
  });
}
