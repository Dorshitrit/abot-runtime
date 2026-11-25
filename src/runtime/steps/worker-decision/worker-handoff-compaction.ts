import { buildCompactedRequestToolResultsMessage } from "../../context/request-tool-results.js";
import { workerCapabilityContextCompactionScopeId, WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../../orchestration/worker-capabilities/index.js";
import { createPolicyModelStepCompactionController } from "../../context/super-compaction/routing.js";
import { readSuperWorkerCompactionSidecar } from "../../context/super-worker-compaction-sidecar.js";
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
  if (!store) return bindWorkerHandoffProjection(input);
  const scopeId = workerCapabilityContextCompactionScopeId(options.call.callId);
  const checkpoint = readWorkerCompactionCheckpoint(
    store,
    options.requestToolResults,
    scopeId,
    WORKER_DECISION_MODEL_STEP,
  );
  if (!checkpoint) return bindWorkerHandoffProjection(input);
  assertWorkerCheckpointApplicable(request, options.call, checkpoint);

  // The evidence step may have committed a newer checkpoint. Reuse that
  // checkpoint with uncovered receipts. The factual report must use this
  // current projection, not the assessment's pre-compaction context.
  request.abortSignal.throwIfAborted();
  const rebuilt = buildWorkerDecisionInput(request, {
    ...options,
    requestToolResultsContextMessage: buildCompactedRequestToolResultsMessage(
      options.requestToolResults,
      checkpoint,
      workerCompactionIntegrityInput(request, options.capabilitySource),
    ),
  });
  const projection = createPolicyModelStepCompactionController(request, {
    consumer: WORKER_DECISION_MODEL_STEP,
    call: options.call,
    sourceRevision: options.requestToolResults.sourceRevision,
    superWorkerCompaction: readSuperWorkerCompactionSidecar(options.requestToolResults),
    requireSuperWorkerSources: workerCompactionIntegrityInput(request, options.capabilitySource) !== undefined,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    scopeId,
  }, request.executionPolicy.authority);
  // project() reuses committed checkpoint state; it never generates a summary.
  return Object.freeze({
    ...rebuilt.resultAuthorSource,
    handoffContextMessages: Object.freeze(projection.project(rebuilt.sharedContextMessages)),
  });
}

function bindWorkerHandoffProjection(
  input: ReturnType<typeof buildWorkerDecisionInput>,
): WorkerResultAuthorSource {
  return Object.freeze({
    ...input.resultAuthorSource,
    handoffContextMessages: input.sharedContextMessages,
  });
}
