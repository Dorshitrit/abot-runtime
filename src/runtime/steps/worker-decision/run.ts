import {
  invokeStructuredModelStep,
  StructuredModelInvalidOutputError,
} from "../../model/invoke-structured-step.js";
import {
  buildCompactedRequestToolResultsMessage,
  projectRequestToolResults,
  type RequestToolResultsView,
} from "../../context/request-tool-results.js";
import {
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  createSemanticCompactionSha256Fingerprint,
  projectSemanticCompactionDependencyResults,
  sameSemanticCompactionCheckpointBinding,
} from "../../context/semantic-compaction/index.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import { emitRuntimeStatus } from "../../events/runtime-status.js";
import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import {
  createWorkerCapabilityBinding,
  materializeWorkerCapabilityControlsIfComplete,
  partitionWorkerCapabilityControlsSchema,
  workerCapabilityContextCompactionScopeId,
  WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
  WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
} from "../../orchestration/worker-capabilities/index.js";
import {
  resolveRequestWorkerCapabilities,
  type RequestExecutionScope,
} from "../../request/execution-scope.js";
import type { RequestRoleExecutionHandoff } from "../../request/result.js";
import type { RoleExecutor } from "../../orchestration/role-executors/index.js";
import { classifyRuntimeErrorType } from "../../observability/error-type.js";
import { traceDebug } from "../../observability/debug-logger.js";
import {
  projectWorkerDecisionCallIdentity,
  type WorkerControlDecision,
  type WorkerDecision,
  type WorkerDecisionStepResult,
  type WorkerDecisionDiagnosticContext,
  type WorkerInvokeCapabilitiesDecision,
  type WorkerInvokeCapabilityDecision,
  type WorkerResultAuthorSource,
  WORKER_DECISION_MODEL_STEP,
} from "./contracts.js";
import {
  traceWorkerClientBatchIntentsPublished,
  traceWorkerClientIntentPublished,
  traceWorkerCapabilityRefinementSkipped,
  traceWorkerCapabilitySelectionReopened,
  traceWorkerModelCompleted,
  traceWorkerModelFailed,
  traceWorkerModelStarted,
} from "./diagnostics.js";
import {
  buildWorkerDecisionInput,
  type WorkerDecisionCapabilityResumeSource,
  type WorkerDecisionCapabilitySource,
  type WorkerSelectedCapabilityBatchExecution,
  type WorkerSelectedCapabilityExecution,
} from "./input.js";
import {
  createWorkerCapabilitySelectionRejection,
  type WorkerCapabilitySelectionRejection,
} from "./capability-selection-rejection.js";
import { parseWorkerDecisionOutput } from "./parser.js";
import { runWorkerResultAuthor } from "./result-author.js";
import {
  projectEffectiveWorkerSelectionControlIds,
  projectEligibleWorkerSessionArtifactPaths,
} from "./runtime-path-refinement.js";

type WorkerPendingCapabilitySelection =
  | Readonly<{
      kind: "single";
      selection: WorkerSelectedCapabilityExecution;
    }>
  | Readonly<{
      kind: "batch";
      selection: WorkerSelectedCapabilityBatchExecution;
    }>;

type RunWorkerDecisionOptions = Readonly<{
  call: RoleCallFrame;
  requestToolResults: RequestToolResultsView;
  capabilitySource?: WorkerDecisionCapabilitySource;
  capabilityResume?: WorkerDecisionCapabilityResumeSource;
  selectedCapabilityExecution?: WorkerSelectedCapabilityExecution;
  selectedCapabilityBatchExecution?: WorkerSelectedCapabilityBatchExecution;
  capabilitySelectionRejection?: WorkerCapabilitySelectionRejection;
}>;

export async function runWorkerDecision(
  request: RequestExecutionScope,
  options: RunWorkerDecisionOptions,
): Promise<WorkerDecision> {
  const decision = await runWorkerDecisionPhase(request, options);
  const pendingCapabilitySelection:
    | WorkerPendingCapabilitySelection
    | undefined = options.selectedCapabilityExecution
    ? { kind: "single", selection: options.selectedCapabilityExecution }
    : options.selectedCapabilityBatchExecution
      ? { kind: "batch", selection: options.selectedCapabilityBatchExecution }
      : undefined;
  if (
    decision.action === "return_failure" &&
    !options.capabilitySelectionRejection &&
    pendingCapabilitySelection
  ) {
    const rejectedSelection = createCapabilitySelectionRejection(
      pendingCapabilitySelection,
      decision.reason,
    );
    traceWorkerCapabilitySelectionReopened({
      diagnostic: {
        requestId: request.requestId,
        modelStep: WORKER_DECISION_MODEL_STEP,
        decisionPhase: "capability_execution",
        ...projectWorkerDecisionCallIdentity(options.call),
      },
      rejection: rejectedSelection.rejection,
      reasonLength: rejectedSelection.reasonLength,
    });
    return runWorkerDecision(request, {
      call: options.call,
      requestToolResults: options.requestToolResults,
      ...(options.capabilitySource
        ? { capabilitySource: options.capabilitySource }
        : {}),
      ...(options.capabilityResume
        ? { capabilityResume: options.capabilityResume }
        : {}),
      capabilitySelectionRejection: rejectedSelection.rejection,
    });
  }
  if (
    decision.action === "return_result" ||
    decision.action === "return_failure"
  ) {
    return decision;
  }
  if (options.selectedCapabilityExecution) {
    if (decision.action !== "invoke_capability") {
      throw new Error("worker_capability_refinement_invalid");
    }
    if (!hasCapabilityControls(decision)) {
      throw new Error("worker_capability_controls_missing");
    }
    return decision;
  }
  if (options.selectedCapabilityBatchExecution) {
    if (decision.action !== "invoke_capabilities") {
      throw new Error("worker_capability_batch_refinement_invalid");
    }
    if (!hasCapabilityBatchControls(decision)) {
      throw new Error("worker_capability_batch_controls_missing");
    }
    return decision;
  }
  if (decision.action === "invoke_capability") {
    assertGuidanceCapabilitiesInScope(options, [decision.capabilityId]);
    const guidance = (
      (await resolveRequestWorkerCapabilities(
        request,
      ).provider.getExecutionGuidance?.(decision.capabilityId)) ?? ""
    ).trim();
    if (guidance.length === 0) {
      const descriptor = options.capabilitySource?.binding.capabilities.find(
        ({ capabilityId }) => capabilityId === decision.capabilityId,
      );
      if (!descriptor) {
        throw new Error("worker_capability_selection_descriptor_missing");
      }
      if (descriptor.controlsRefinement === "mechanical_when_complete") {
        const eligibleSessionArtifactPaths =
          projectEligibleWorkerSessionArtifactPaths(
            request.sessionArtifactPaths,
            options.requestToolResults,
          );
        const effectiveSelectionControlIds =
          projectEffectiveWorkerSelectionControlIds(
            descriptor,
            eligibleSessionArtifactPaths.length > 0,
          );
        const partition = partitionWorkerCapabilityControlsSchema(
          descriptor.controls,
          effectiveSelectionControlIds,
        );
        if (!partition.ok) {
          throw new Error("worker_capability_controls_partition_invalid");
        }
        const selectionControls =
          "selectionControls" in decision && decision.selectionControls
            ? decision.selectionControls
            : Object.freeze({});
        const materialized = materializeWorkerCapabilityControlsIfComplete(
          partition.value,
          selectionControls,
        );
        if (materialized) {
          if (!materialized.ok) {
            throw new Error("worker_capability_selection_controls_invalid");
          }
          traceWorkerCapabilityRefinementSkipped({
            diagnostic: {
              requestId: request.requestId,
              modelStep: WORKER_DECISION_MODEL_STEP,
              decisionPhase: "capability_execution",
              ...projectWorkerDecisionCallIdentity(options.call),
            },
            capabilityId: decision.capabilityId,
            selectionControlCount: Object.keys(selectionControls).length,
          });
          return Object.freeze({
            action: "invoke_capability" as const,
            capabilityId: decision.capabilityId,
            intent: decision.intent,
            controls: materialized.value,
          });
        }
      }
    }
    return runWorkerDecision(request, {
      ...options,
      selectedCapabilityExecution: {
        capabilityId: decision.capabilityId,
        intent: decision.intent,
        ...("selectionControls" in decision && decision.selectionControls
          ? { selectionControls: decision.selectionControls }
          : {}),
        guidance,
      },
    });
  }
  const uniqueCapabilityIds = [
    ...new Set(decision.invocations.map(({ capabilityId }) => capabilityId)),
  ];
  assertGuidanceCapabilitiesInScope(options, uniqueCapabilityIds);
  const guidanceByCapabilityId = new Map(
    await Promise.all(
      uniqueCapabilityIds.map(
        async (capabilityId) =>
          [
            capabilityId,
            (
              (await resolveRequestWorkerCapabilities(
                request,
              ).provider.getExecutionGuidance?.(capabilityId)) ?? ""
            ).trim(),
          ] as const,
      ),
    ),
  );
  return runWorkerDecision(request, {
    ...options,
    selectedCapabilityBatchExecution: Object.freeze({
      invocations: Object.freeze(
        decision.invocations.map(
          ({ capabilityId, intent, ...invocationSelection }) =>
            Object.freeze({
              capabilityId,
              intent,
              ...("selectionControls" in invocationSelection &&
              invocationSelection.selectionControls
                ? {
                    selectionControls: invocationSelection.selectionControls,
                  }
                : {}),
              guidance: guidanceByCapabilityId.get(capabilityId) ?? "",
            }),
        ),
      ),
    }),
  });
}

async function runWorkerDecisionPhase(
  request: RequestExecutionScope,
  options: RunWorkerDecisionOptions,
): Promise<WorkerDecisionStepResult> {
  const input = await prepareWorkerDecisionInput(request, options);
  const diagnostic: WorkerDecisionDiagnosticContext = input.diagnostic;
  const startedAt = Date.now();

  traceWorkerModelStarted({
    diagnostic,
    messageCount: input.context.messages.length,
    messageCharacterCount: input.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    allowedActions: input.allowedActions,
  });

  let controlDecision: WorkerControlDecision;
  try {
    controlDecision = await invokeStructuredModelStep({
      request,
      modelStep: input.modelStep,
      format: input.format,
      messages: input.context.messages,
      contextCompaction: createModelStepCompactionController(request, {
        call: options.call,
        sourceRevision: options.requestToolResults.sourceRevision,
        allowedConsumers:
          WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
        scopeId: workerCapabilityContextCompactionScopeId(options.call.callId),
      }),
      timeoutReason: "worker_decision_timeout",
      invalidOutputReason: "invalid_worker_decision",
      parse: (text) => {
        const parsed = parseWorkerDecisionOutput(text, diagnostic, {
          availableCapabilities: input.availableCapabilities,
          maxBatchCapabilityExecutions: input.maxBatchCapabilityExecutions,
          decisionPhase: diagnostic.decisionPhase,
          ...(input.pendingCapabilitySelection
            ? {
                pendingCapabilitySelection: input.pendingCapabilitySelection,
              }
            : {}),
          ...(input.pendingCapabilityBatchSelection
            ? {
                pendingCapabilityBatchSelection:
                  input.pendingCapabilityBatchSelection,
              }
            : {}),
        });
        return parsed;
      },
    });
    traceWorkerModelCompleted({
      diagnostic,
      decision: controlDecision,
      durationMs: Date.now() - startedAt,
    });
  } catch (error: unknown) {
    traceWorkerModelFailed({
      diagnostic,
      durationMs: Date.now() - startedAt,
      errorType: classifyRuntimeErrorType(error),
      invalidStructuredOutput:
        error instanceof StructuredModelInvalidOutputError,
    });
    throw error;
  }
  if (controlDecision.action !== "return_result") {
    return controlDecision;
  }
  const resultAuthorSource = await completeWorkerHandoffEvidence(
    request,
    options,
    input,
  );
  const result = await runWorkerResultAuthor(request, {
    diagnostic,
    source: resultAuthorSource,
  });
  return Object.freeze({
    action: "return_result" as const,
    result,
  });
}

async function completeWorkerHandoffEvidence(
  request: RequestExecutionScope,
  options: Parameters<typeof buildWorkerDecisionInput>[1],
  input: ReturnType<typeof buildWorkerDecisionInput>,
): Promise<WorkerResultAuthorSource> {
  const store = request.contextCompactionStore;
  if (!store) return input.resultAuthorSource;
  const scopeId = workerCapabilityContextCompactionScopeId(
    options.call.callId,
  );
  const checkpoint = store.get(scopeId);
  if (!checkpoint) return input.resultAuthorSource;
  assertWorkerCheckpointApplicable(request, options.call, checkpoint);

  const prepared = await createModelStepCompactionController(request, {
    call: options.call,
    sourceRevision: options.requestToolResults.sourceRevision,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    scopeId,
  }).prepare(input.context.messages);
  prepared.commit();

  const refreshedCheckpoint = store.get(scopeId);
  if (!refreshedCheckpoint) {
    throw new Error("context_compaction_handoff_checkpoint_missing");
  }
  assertWorkerCheckpointApplicable(
    request,
    options.call,
    refreshedCheckpoint,
  );
  return buildWorkerDecisionInput(request, {
    ...options,
    requestToolResultsContextMessage: buildCompactedRequestToolResultsMessage(
      options.requestToolResults,
      refreshedCheckpoint,
    ),
  }).resultAuthorSource;
}

async function prepareWorkerDecisionInput(
  request: RequestExecutionScope,
  options: Parameters<typeof buildWorkerDecisionInput>[1],
): Promise<ReturnType<typeof buildWorkerDecisionInput>> {
  const store = request.contextCompactionStore;
  const scopeId = workerCapabilityContextCompactionScopeId(options.call.callId);
  const previous = store?.get(scopeId);
  if (previous) {
    assertWorkerCheckpointApplicable(request, options.call, previous);
  }
  return buildWorkerDecisionInput(request, {
    ...options,
    ...(previous
      ? {
          requestToolResultsContextMessage:
            buildCompactedRequestToolResultsMessage(
              options.requestToolResults,
              previous,
            ),
        }
      : {}),
  });
}

function createWorkerCompactionBinding(
  request: RequestExecutionScope,
  call: RoleCallFrame,
) {
  return Object.freeze({
    requestId: request.requestId,
    currentRequestFingerprint: createSemanticCompactionSha256Fingerprint(
      request.prompt,
    ),
    roleId: "worker",
    callId: call.callId,
    objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
      call.objective!,
    ),
    contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
  });
}

function assertWorkerCheckpointApplicable(
  request: RequestExecutionScope,
  call: RoleCallFrame,
  checkpoint: Parameters<
    NonNullable<RequestExecutionScope["contextCompactionStore"]>["commit"]
  >[0],
): void {
  if (
    !sameSemanticCompactionCheckpointBinding(
      checkpoint,
      createWorkerCompactionBinding(request, call),
    )
  ) {
    throw new Error("context_compaction_checkpoint_not_applicable");
  }
}

export const GENERIC_WORKER_EXECUTOR: RoleExecutor<
  RequestExecutionScope,
  RequestRoleExecutionHandoff
> = Object.freeze({
  roleId: "worker",
  async execute({ context, call, ledger, continuation }) {
    if (continuation?.kind === "role_child") {
      throw new Error("worker_role_child_continuation_unsupported");
    }
    emitRuntimeStatus(context, {
      stage: "worker",
      phase: "working",
      message: "Working on the delegated task...",
    });
    const head = ledger.current();
    const dependencyResults = projectSemanticCompactionDependencyResults({
      requestId: context.requestId,
      prompt: context.prompt,
      head,
      call,
      consumer: WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
      ...(context.contextCompactionStore
        ? { store: context.contextCompactionStore }
        : {}),
    });
    const requestToolResults = projectRequestToolResults({
      ledger,
      head,
      modelStep: WORKER_DECISION_MODEL_STEP,
      callId: call.callId,
    });
    const workerCapabilities = resolveRequestWorkerCapabilities(context);
    const binding = createWorkerCapabilityBinding({
      requestId: context.requestId,
      context: workerCapabilities.executionContext,
      call,
      ledger,
      adapters: workerCapabilities.provider.getAdapters(),
      ...(dependencyResults.length > 0 ? { dependencyResults } : {}),
    });
    const capabilitySource = {
      binding,
      ledger,
      head,
    };
    const capabilityResume = continuation
      ? {
          ledger,
          head,
          ...(continuation.kind === "capability_batch_execution"
            ? { executionIds: continuation.executionIds }
            : { executionId: continuation.executionId }),
        }
      : undefined;
    const decision = await runWorkerDecision(context, {
      call,
      requestToolResults,
      capabilitySource,
      ...(capabilityResume ? { capabilityResume } : {}),
    });
    if (decision.action === "return_result") {
      return Object.freeze({
        kind: "terminal",
        outcome: "completed",
        summary: decision.result,
      });
    }
    if (decision.action === "return_failure") {
      return Object.freeze({
        kind: "terminal",
        outcome: "failed",
        summary: decision.reason,
      });
    }
    if (decision.action === "invoke_capabilities") {
      context.onThinkingDelta(
        `${decision.invocations.map(({ intent }) => intent).join("\n")}\n\n`,
      );
      traceWorkerClientBatchIntentsPublished({
        diagnostic: {
          requestId: context.requestId,
          modelStep: WORKER_DECISION_MODEL_STEP,
          decisionPhase: "capability_execution",
          ...projectWorkerDecisionCallIdentity(call),
        },
        capabilityIds: decision.invocations.map(
          ({ capabilityId }) => capabilityId,
        ),
        intentLengths: decision.invocations.map(({ intent }) => intent.length),
      });
      const execution = await binding.executeBatch({
        invocations: decision.invocations.map((invocation) => ({
          capabilityId: invocation.capabilityId,
          intent: invocation.intent,
          controls: invocation.controls,
        })),
      });
      return Object.freeze({
        kind: "continue",
        continuation: Object.freeze({
          kind: "capability_batch_execution",
          executionIds: execution.executionIds,
        }),
      });
    }
    context.onThinkingDelta(`${decision.intent}\n\n`);
    traceWorkerClientIntentPublished({
      diagnostic: {
        requestId: context.requestId,
        modelStep: WORKER_DECISION_MODEL_STEP,
        decisionPhase: "capability_execution",
        ...projectWorkerDecisionCallIdentity(call),
      },
      capabilityId: decision.capabilityId,
      intentLength: decision.intent.length,
    });
    const execution = await binding.execute({
      capabilityId: decision.capabilityId,
      intent: decision.intent,
      controls: decision.controls,
    });
    return Object.freeze({
      kind: "continue",
      continuation: Object.freeze({
        kind: "capability_execution",
        executionId: execution.executionId,
      }),
    });
  },
});

function assertGuidanceCapabilitiesInScope(
  options: RunWorkerDecisionOptions,
  capabilityIds: readonly string[],
): void {
  const availableCapabilityIds = new Set(
    options.capabilitySource?.binding.capabilities.map(
      ({ capabilityId }) => capabilityId,
    ) ?? [],
  );
  if (
    !options.capabilitySource ||
    capabilityIds.some(
      (capabilityId) => !availableCapabilityIds.has(capabilityId),
    )
  ) {
    throw new Error("worker_capability_guidance_out_of_scope");
  }
}

function hasCapabilityControls(
  decision: Extract<WorkerControlDecision, { action: "invoke_capability" }>,
): decision is WorkerInvokeCapabilityDecision {
  return "controls" in decision;
}

function hasCapabilityBatchControls(
  decision: Extract<WorkerControlDecision, { action: "invoke_capabilities" }>,
): decision is WorkerInvokeCapabilitiesDecision {
  return decision.invocations.every((invocation) => "controls" in invocation);
}

function createCapabilitySelectionRejection(
  pendingSelection: WorkerPendingCapabilitySelection,
  reason: string,
): ReturnType<typeof createWorkerCapabilitySelectionRejection> {
  if (pendingSelection.kind === "single") {
    return createWorkerCapabilitySelectionRejection({
      rejectedSelectionKind: "single",
      rejectedCapabilityIds: [pendingSelection.selection.capabilityId],
      rejectedInvocationCount: 1,
      reason,
    });
  }
  return createWorkerCapabilitySelectionRejection({
    rejectedSelectionKind: "batch",
    rejectedCapabilityIds: [
      ...new Set(
        pendingSelection.selection.invocations.map(
          ({ capabilityId }) => capabilityId,
        ),
      ),
    ],
    rejectedInvocationCount: pendingSelection.selection.invocations.length,
    reason,
  });
}
