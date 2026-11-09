import { buildCompactedRequestToolResultsMessage } from "../../context/request-tool-results.js";
import { workerCapabilityContextCompactionScopeId } from "../../orchestration/worker-capabilities/index.js";
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

  // The evidence step may have committed a newer checkpoint. Reuse that
  // checkpoint with uncovered receipts; result admission owns any further
  // compaction after measuring the complete next-model input.
  request.abortSignal.throwIfAborted();
  return buildWorkerDecisionInput(request, {
    ...options,
    requestToolResultsContextMessage: buildCompactedRequestToolResultsMessage(
      options.requestToolResults,
      checkpoint,
      workerCompactionIntegrityInput(request, options.capabilitySource),
    ),
  }).resultAuthorSource;
}
