import {
  assertSuperCompactionCheckpointIntegrity,
  type SuperCompactionIntegrityInput,
} from "./semantic-compaction/super-source-integrity.js";
import type { SemanticCompactionCheckpoint } from "./semantic-compaction/contracts.js";
import { projectCanonicalCapabilityResultCompactionSources } from "./capability-result-compaction-source.js";
import type { RequestToolResultsView } from "./request-tool-results.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import {
  superWorkerCompactionFailureOwner,
  withSuperWorkerCompactionFailure,
} from "./super-worker-compaction-failure.js";
import { projectRequestToolResultsCheckpointMessage } from "./request-tool-results-checkpoint.js";
import { bindRequestToolResultsMessage } from "./request-tool-results-message-binding.js";
import {
  assertSuperWorkerCompactionSidecarBinding,
  readSuperWorkerCompactionSidecar,
} from "./super-worker-compaction-sidecar.js";

/** Validates all provenance before projecting a mixed checkpoint at handoff. */
export function projectSuperCompactedRequestToolResults(
  view: RequestToolResultsView,
  checkpoint: SemanticCompactionCheckpoint,
  integrity: SuperCompactionIntegrityInput,
  message: ChatMessage,
) {
  const sidecar = readSuperWorkerCompactionSidecar(view);
  if (!sidecar) throw new Error("context_compaction_source_binding_required");
  assertSuperWorkerCompactionSidecarBinding(sidecar, {
    requestId: integrity.requestId,
    callId: checkpoint.callId,
    sourceRevision: integrity.head.revision,
  });
  return withSuperWorkerCompactionFailure(
    superWorkerCompactionFailureOwner(
      sidecar,
      MODEL_STEPS.WORKER_DECISION,
      "worker_checkpoint_projection",
      checkpoint.scopeId,
    ),
    () => {
      assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint });
      const sources = projectCanonicalCapabilityResultCompactionSources({
        head: integrity.head,
        callId: checkpoint.callId,
      });
      const projected = projectRequestToolResultsCheckpointMessage(
        message,
        checkpoint,
        new Map(sources.map((source) => [source.sourceRef, source])),
      );
      if (!projected)
        throw new Error("context_compaction_source_message_binding_invalid");
      return bindRequestToolResultsMessage(view, projected.content);
    },
  );
}
