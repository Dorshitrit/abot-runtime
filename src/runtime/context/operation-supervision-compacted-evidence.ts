import { projectCompactedCapabilityResultReceipt } from "./compacted-capability-result-receipt.js";
import { createCapabilityResultCompactionSource } from "./capability-result-compaction-source.js";
import { matchesCompactedExecutionResult } from "./execution-compacted-evidence.js";
import type { OperationSupervisionEvidenceEntry } from "./operation-supervision-evidence.js";
import type { OperationSupervisionEvidenceContext } from "./operation-supervision-evidence-binding.js";
import type {
  SemanticCompactionCheckpoint,
  SemanticCompactionSource,
} from "./semantic-compaction/contracts.js";
import type { RequestContextCompactionStore } from "./semantic-compaction/store.js";
import { traceDebug } from "../observability/debug-logger.js";

export type OperationSupervisionCompaction = Readonly<{
  // Supplied by the controller after projecting this verified checkpoint.
  checkpoint: SemanticCompactionCheckpoint;
  store: RequestContextCompactionStore;
}>;

type EmbeddedEvidence = Exclude<
  OperationSupervisionEvidenceEntry["evidence"],
  { kind: "existing_exact_capability_result_lane" }
>;

/** Keep the canonical repeat notice without resurrecting its compacted result. */
export function resolveCompactedOperationSupervisionEvidence(
  executionId: string,
  evidence: EmbeddedEvidence,
  context: OperationSupervisionEvidenceContext,
  compaction: OperationSupervisionCompaction | undefined,
) {
  if (!compaction) return undefined;
  const { checkpoint, store } = compaction;
  const receipt = evidence.receipt;
  const isSameOwnerCheckpoint =
    checkpoint.requestId === context.requestId &&
    checkpoint.callId === context.call.callId &&
    checkpoint.roleId === context.call.roleId &&
    checkpoint.sourceRevision <= context.sourceRevision &&
    receipt.callId === context.call.callId &&
    receipt.executionId === executionId;
  if (!isSameOwnerCheckpoint) return undefined;
  const permitsConsumer =
    context.consumer !== undefined &&
    checkpoint.allowedConsumers.includes(context.consumer);
  if (!permitsConsumer) return undefined;

  const nativeSourceRef = `tool-result:${executionId}`;
  const digest = checkpoint.sourceDigests.find(
    (source) =>
      source.sourceRef === nativeSourceRef || source.sourceRef === executionId,
  );
  if (!digest) return undefined;
  const source = store.materializeSource(
    digest.sourceRef,
    digest.sourceFingerprint,
  );
  if (!source) return undefined;
  if (!matchesRegisteredSupervisionResult(source, executionId, evidence))
    return undefined;

  // Only verified output aliases can be replaced; independent summary facts stay.
  const compactedReceipt = projectCompactedCapabilityResultReceipt({
    ...receipt,
    adapterResult: evidence.adapterResult,
  });
  traceDebug("runtime.context.compaction", "supervision.evidence_reused", {
    requestId: context.requestId,
    modelStep: context.consumer,
    scopeId: checkpoint.scopeId,
    sourceRevision: checkpoint.sourceRevision,
    executionId,
    sourceRef: digest.sourceRef,
  });
  return Object.freeze({
    kind: "compacted_capability_result_reference" as const,
    executionId,
    scopeId: checkpoint.scopeId,
    sourceRef: digest.sourceRef,
    sourceFingerprint: digest.sourceFingerprint,
    acceptedAction: evidence.acceptedAction,
    receipt: Object.freeze({
      executionId: receipt.executionId,
      callId: receipt.callId,
      invocationAttempt: receipt.invocationAttempt,
      capabilityId: receipt.capabilityId,
      declaredEffect: receipt.declaredEffect,
      outcome: receipt.outcome,
      observedEffect: receipt.observedEffect,
      summary: compactedReceipt.summary,
    }),
  });
}

function matchesRegisteredSupervisionResult(
  source: SemanticCompactionSource,
  executionId: string,
  evidence: EmbeddedEvidence,
): boolean {
  const exactResult = {
    ...evidence.receipt,
    acceptedAction: evidence.acceptedAction,
    adapterResult: evidence.adapterResult,
  };
  const isNativeResultSource =
    source.sourceRef === `tool-result:${executionId}`;
  if (isNativeResultSource)
    return matchesCompactedExecutionResult(source.content, exactResult);
  const canonical = createCapabilityResultCompactionSource(exactResult);
  return canonical.sourceFingerprint === source.sourceFingerprint;
}
