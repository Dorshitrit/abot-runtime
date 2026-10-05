import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import {
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  createSemanticCompactionSha256Fingerprint,
  sameSemanticCompactionCheckpointBinding,
} from "../../context/semantic-compaction/index.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../../orchestration/worker-capabilities/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { hasSuperContextContract } from "../../context/super-context-policy.js";
import type { SuperCompactionIntegrityInput } from "../../context/semantic-compaction/super-source-integrity.js";
import type { WorkerDecisionCapabilitySource } from "./input.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import type { RequestContextCompactionStore } from "../../context/semantic-compaction/store.js";
import { readSuperWorkerCompactionSidecar } from "../../context/super-worker-compaction-sidecar.js";
import {
  superWorkerCompactionFailureOwner,
  withSuperWorkerCompactionFailure,
} from "../../context/super-worker-compaction-failure.js";

export function workerCompactionIntegrityInput(
  request: RequestExecutionScope,
  source?: WorkerDecisionCapabilitySource,
): SuperCompactionIntegrityInput | undefined {
  if (!source || !request.contextCompactionStore) return undefined;
  if (
    !hasSuperContextContract(source.head.policy.authority, "delegated.worker")
  )
    return undefined;
  if (source.ledger.current() !== source.head)
    throw new Error("request_tool_results_head_stale");
  return {
    requestId: request.requestId,
    prompt: request.prompt,
    head: source.head,
    store: request.contextCompactionStore,
  };
}

/** A quarantined scope is rejected at the bound invocation before any model call. */
export function readWorkerCompactionCheckpoint(
  store: RequestContextCompactionStore,
  view: RequestToolResultsView,
  scopeId: string,
  consumer: ModelStep,
) {
  const owner = superWorkerCompactionFailureOwner(
    readSuperWorkerCompactionSidecar(view),
    consumer,
    "worker_checkpoint_read",
    scopeId,
  );
  return withSuperWorkerCompactionFailure(owner, () => store.get(scopeId));
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

export function assertWorkerCheckpointApplicable(
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
