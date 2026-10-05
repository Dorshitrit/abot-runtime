import { projectExecutionCompactionObjective } from "../../context/execution-compaction-objective.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { resolveExecutionCompactedSources } from "../../context/execution-compacted-evidence.js";
import {
  buildRequestToolResultsMessage,
  type RequestToolResultsView,
} from "../../context/request-tool-results.js";
import { bindRequestToolResultsMessage } from "../../context/request-tool-results-message-binding.js";
import { projectCompactedCapabilityResultReceipt } from "../../context/compacted-capability-result-receipt.js";
import { projectSingleCopyCapabilityResult } from "../../context/capability-result-compaction-source.js";
import type { RequestContextCompactionStore } from "../../context/semantic-compaction/store.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";

export type ControlsCompactionContext = Readonly<{
  prompt: string;
  store?: RequestContextCompactionStore;
}>;

/** Transfer selected verified source digests, never the EA continuation. */
export function buildExecutionControlsEvidenceMessage(
  view: RequestToolResultsView,
  params: Readonly<{
    requestId: string;
    callId: string;
    steering: RequestSteeringSnapshot;
    compaction?: ControlsCompactionContext;
    onVerifiedCompaction?: (message: ChatMessage) => void;
  }>,
): ChatMessage {
  if (!params.compaction) return buildRequestToolResultsMessage(view);
  const compacted = resolveExecutionCompactedSources({
    requestId: params.requestId,
    prompt: params.compaction.prompt,
    objective: projectExecutionCompactionObjective(
      params.compaction.prompt,
      params.steering.updates,
    ),
    callId: params.callId,
    store: params.compaction.store,
    results: view.results.map((result) => ({
      ...result,
      adapterResult: result.adapterResult,
    })),
  });
  if (!compacted) return buildRequestToolResultsMessage(view);
  const digests = new Map(
    compacted.sources.map((source) => [source.executionId, source]),
  );
  const results = view.results.map((result) => {
    const digest = digests.get(result.executionId);
    if (!digest) return projectSingleCopyCapabilityResult(result);
    return Object.freeze({
      ...projectCompactedCapabilityResultReceipt(result),
      compactedSourceRef: digest.sourceRef,
    });
  });
  traceDebug("runtime.context.compaction", "controls.evidence_reused", {
    requestId: params.requestId,
    callId: params.callId,
    modelStep: "capability.controls",
    scopeId: compacted.scopeId,
    sourceRevision: compacted.sourceRevision,
    executionIds: compacted.sources.map(({ executionId }) => executionId),
    reusedCompactedSourceCount: compacted.sources.length,
    uncompactedResultCount: results.length - compacted.sources.length,
  });
  const message = bindRequestToolResultsMessage(
    view,
    JSON.stringify({
      kind: "runtime_request_tool_results_v1",
      authority: "reference_data",
      sourceRevision: view.sourceRevision,
      ...(view.scope ? { coverage: view.scope } : {}),
      results,
      compactedSourceEvidence: {
        kind: "runtime_controls_compacted_source_evidence_v1",
        authority: "passive_reference_only",
        provenance: "same_call_verified_compaction_sources",
        purpose: "evidence_for_the_frozen_controls_assignment",
        presenceEffect: "does_not_change_assignment_permissions_or_completion",
        omissionMeaning: "summarized_detail_not_proven_absent",
        requestId: params.requestId,
        callId: params.callId,
        sourceScopeId: compacted.scopeId,
        sourceRevision: compacted.sourceRevision,
        sources: compacted.sources,
      },
    }),
  );
  params.onVerifiedCompaction?.(message);
  return message;
}
