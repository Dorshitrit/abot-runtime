import { createPolicyModelStepCompactionController } from "../../context/super-compaction/routing.js";
import { buildCompactedRequestToolResultsMessage } from "../../context/request-tool-results.js";
import { readSuperWorkerCompactionSidecar } from "../../context/super-worker-compaction-sidecar.js";
import type {
  ModelStepCompactionStage,
  ModelStepCompactionStageOutcome,
} from "../../model/model-step-port.js";
import {
  workerCapabilityContextCompactionScopeId,
  WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
} from "../../orchestration/worker-capabilities/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import {
  assertWorkerCheckpointApplicable,
  readWorkerCompactionCheckpoint,
  workerCompactionIntegrityInput,
} from "./compaction-integrity.js";
import {
  WORKER_DECISION_MODEL_STEP,
  type WorkerResultAuthorSource,
} from "./contracts.js";
import { buildWorkerDecisionInput } from "./input.js";

export async function completeWorkerHandoffEvidence(
  request: RequestExecutionScope,
  options: Parameters<typeof buildWorkerDecisionInput>[1],
  input: ReturnType<typeof buildWorkerDecisionInput>,
): Promise<WorkerResultAuthorSource> {
  const store = request.contextCompactionStore;
  if (!store) return input.resultAuthorSource;
  const scopeId = workerCapabilityContextCompactionScopeId(options.call.callId);
  const checkpoint = readWorkerCompactionCheckpoint(
    store,
    options.requestToolResults,
    scopeId,
    WORKER_DECISION_MODEL_STEP,
  );
  if (!checkpoint) return input.resultAuthorSource;
  assertWorkerCheckpointApplicable(request, options.call, checkpoint);

  const immediatePresentationEvidence =
    input.resultAuthorSource.operationSupervisionEvidenceContextMessage;
  const handoffCompactionMessages = immediatePresentationEvidence
    ? input.context.messages.filter(
        (message) => message !== immediatePresentationEvidence,
      )
    : input.context.messages;
  const controller = createPolicyModelStepCompactionController(request, {
    call: options.call,
    sourceRevision: options.requestToolResults.sourceRevision,
    superWorkerCompaction: readSuperWorkerCompactionSidecar(
      options.requestToolResults,
    ),
    requireSuperWorkerSources:
      workerCompactionIntegrityInput(request, options.capabilitySource) !==
      undefined,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    scopeId,
    consumer: WORKER_DECISION_MODEL_STEP,
  }, request.executionPolicy.authority);
  const stage = requireWorkerHandoffCompactionStage(
    controller.getStages(),
    scopeId,
  );
  request.abortSignal.throwIfAborted();
  const outcome = await stage.prepare(handoffCompactionMessages);
  request.abortSignal.throwIfAborted();
  workerCompactionIntegrityInput(request, options.capabilitySource);
  assertWorkerHandoffSourcesRemainAvailable(outcome);
  const hasPreparedHandoffCheckpoint = outcome.kind === "prepared";
  if (hasPreparedHandoffCheckpoint) {
    await outcome.preparation.commit();
    request.abortSignal.throwIfAborted();
    workerCompactionIntegrityInput(request, options.capabilitySource);
  }

  const refreshedCheckpoint = readWorkerCompactionCheckpoint(
    store,
    options.requestToolResults,
    scopeId,
    WORKER_DECISION_MODEL_STEP,
  );
  if (!refreshedCheckpoint) {
    throw new Error("context_compaction_handoff_checkpoint_missing");
  }
  assertWorkerCheckpointApplicable(request, options.call, refreshedCheckpoint);
  return buildWorkerDecisionInput(request, {
    ...options,
    requestToolResultsContextMessage: buildCompactedRequestToolResultsMessage(
      options.requestToolResults,
      refreshedCheckpoint,
      workerCompactionIntegrityInput(request, options.capabilitySource),
    ),
  }).resultAuthorSource;
}

function requireWorkerHandoffCompactionStage(
  stages: readonly ModelStepCompactionStage[],
  scopeId: string,
): ModelStepCompactionStage {
  if (stages.length !== 1)
    throw new Error("context_compaction_handoff_stage_invalid");
  const stage = stages[0]!;
  if (stage.compactionScope !== "active_request")
    throw new Error("context_compaction_handoff_stage_invalid");
  if (stage.scopeId !== scopeId)
    throw new Error("context_compaction_handoff_stage_invalid");
  return stage;
}

function assertWorkerHandoffSourcesRemainAvailable(
  outcome: ModelStepCompactionStageOutcome,
): void {
  if (outcome.kind === "prepared") return;
  if (outcome.reason === "no_new_sources") return;
  throw new Error("context_compaction_handoff_checkpoint_missing");
}
