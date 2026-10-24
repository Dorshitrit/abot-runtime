import { projectExecutionCompactionObjective } from "../context/execution-compaction-objective.js";
import { resolveExecutionCompactedSources } from "../context/execution-compacted-evidence.js";
import { projectCompactedCapabilityResultReceipt } from "../context/compacted-capability-result-receipt.js";
import type { RequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import type { WorkerCapabilityPayloadContext } from "../orchestration/worker-capabilities/payload-contracts.js";
import type { WorkerSettledCapabilityResult } from "../orchestration/worker-capabilities/contracts.js";

type PayloadEvidenceRequest = Readonly<{
  requestId: string;
  prompt: string;
  contextCompactionStore?: RequestContextCompactionStore;
}>;

/** Reuses source evidence only; the payload keeps its own accepted assignment. */
export function projectExecutionPayloadCompactedEvidence(
  request: PayloadEvidenceRequest,
  context: WorkerCapabilityPayloadContext,
  results: readonly WorkerSettledCapabilityResult[],
) {
  if (!("root" in context)) return { results, evidence: undefined };
  if (context.contextScope === "target_only")
    return { results, evidence: undefined };
  const compacted = resolveExecutionCompactedSources({
    requestId: request.requestId,
    prompt: request.prompt,
    objective: projectExecutionCompactionObjective(
      request.prompt,
      context.root.updates,
    ),
    callId: context.root.callId,
    updates: context.root.updates,
    store: request.contextCompactionStore,
    results,
  });
  if (!compacted) return { results, evidence: undefined };
  const digests = new Map(
    compacted.sources.map((digest) => [digest.executionId, digest]),
  );
  const projected = results.map((result) => {
    const digest = digests.get(result.executionId);
    if (!digest) return result;
    return Object.freeze({
      ...projectCompactedCapabilityResultReceipt(result),
      compactedSourceRef: digest.sourceRef,
    });
  });

  return Object.freeze({
    results: Object.freeze(projected),
    evidence: Object.freeze({
      kind: "runtime_payload_compacted_source_evidence_v1",
      authority: "passive_reference_only",
      provenance: "same_call_verified_compaction_sources",
      purpose: "evidence_for_the_accepted_payload_assignment",
      presenceEffect: "does_not_change_assignment_permissions_or_completion",
      omissionMeaning: "summarized_detail_not_proven_absent",
      requestId: request.requestId,
      callId: context.root.callId,
      sourceScopeId: compacted.scopeId,
      sourceRevision: compacted.sourceRevision,
      sources: compacted.sources,
    }),
  });
}
