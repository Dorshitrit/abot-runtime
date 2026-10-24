import type { CheckpointProjectionOptions } from "./semantic-compaction/checkpoint-message.js";
import { projectCompactedRegisteredOutputSummary } from "./compacted-capability-result-receipt.js";
import { CompactionSourceInvariantError } from "./compaction-source-invariant.js";
import { readSuperWorkerCompactionSidecar } from "./super-worker-compaction-sidecar.js";
import {
  bindRequestToolResultsMessage,
  readBoundRequestToolResultsView,
} from "./request-tool-results-message-binding.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "./semantic-compaction/evidence-scope.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionSource,
} from "./semantic-compaction/contracts.js";

export function projectRequestToolResultsCheckpointMessage(
  message: ChatMessage,
  checkpoint: SemanticCompactionCheckpoint,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
  options: CheckpointProjectionOptions = {},
): ChatMessage | undefined {
  const record = parseJsonRecord(message.content);
  if (record?.kind !== "runtime_request_tool_results_v1") return undefined;
  if (message.role !== "user" || message.attachments?.length) {
    throw new Error("context_compaction_request_tool_results_invalid");
  }
  const previousProjection = parseRecord(record.semanticCheckpoint);
  const previousScopeId = readNonEmptyString(previousProjection?.scopeId);
  if (
    previousScopeId &&
    previousScopeId !== checkpoint.scopeId &&
    previousScopeId !== options.replacesScopeId
  ) {
    throw new Error("context_compaction_checkpoint_scope_conflict");
  }
  const view = readBoundRequestToolResultsView(message);
  const superSources = view
    ? readSuperWorkerCompactionSidecar(view)
    : undefined;
  const covered = new Map(
    checkpoint.sourceDigests.map((source) => [source.sourceRef, source]),
  );
  const coveredResults = new Map<string, Record<string, unknown>>();
  for (const receipt of readRecordArray(previousProjection?.coveredResults)) {
    const executionId = readNonEmptyString(receipt.executionId);
    const fingerprint = readNonEmptyString(receipt.sourceFingerprint);
    const source = executionId
      ? resolveResultSource(receipt, undefined, resultSourceOverrides)
      : undefined;
    const exact = source ? covered.get(source.sourceRef) : undefined;
    if (
      !executionId ||
      !fingerprint ||
      exact?.sourceFingerprint !== fingerprint
    ) {
      if (superSources)
        throw new CompactionSourceInvariantError(
          "context_compaction_checkpoint_receipt_invalid",
          executionId,
        );
      throw new Error("context_compaction_checkpoint_receipt_invalid");
    }
    coveredResults.set(
      executionId,
      projectCoveredResultSummary(receipt, source, fingerprint),
    );
  }
  const remainingResults: Record<string, unknown>[] = [];
  for (const result of readRecordArray(record.results)) {
    const executionId = readNonEmptyString(result.executionId);
    const source = resolveResultSource(
      result,
      undefined,
      resultSourceOverrides,
    );
    const exact = source ? covered.get(source.sourceRef) : undefined;
    if (!executionId || !source || !exact) {
      remainingResults.push(result);
      continue;
    }
    if (source.sourceFingerprint !== exact.sourceFingerprint) {
      if (superSources)
        throw new CompactionSourceInvariantError(
          "context_compaction_source_identity_conflict",
          source.sourceRef,
        );
      throw new Error("context_compaction_source_identity_conflict");
    }
    const {
      referenceData: _referenceData,
      adapterResult: _adapterResult,
      ...receipt
    } = result;
    coveredResults.set(
      executionId,
      Object.freeze({
        ...projectCoveredResultSummary(
          receipt,
          source,
          exact.sourceFingerprint,
        ),
        sourceFingerprint: exact.sourceFingerprint,
      }),
    );
  }
  const projected = Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      ...record,
      semanticCheckpoint: {
        kind: checkpoint.kind,
        evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
        scopeId: checkpoint.scopeId,
        roleId: checkpoint.roleId,
        callId: checkpoint.callId,
        checkpointSourceRevision: checkpoint.sourceRevision,
        ...(options.includeContinuation === false
          ? { authority: "passive_source_evidence" }
          : {}),
        presenceEffect:
          options.includeContinuation === false
            ? "passive_source_evidence_not_current_intent_or_completion"
            : "passive_role_continuation_not_user_intent_or_completion",
        coveredSources: checkpoint.sourceDigests.map(
          ({ sourceRef, sourceFingerprint, digest }) => ({
            sourceRef,
            sourceFingerprint,
            digest,
          }),
        ),
        ...(options.includeContinuation === false
          ? {}
          : { continuation: checkpoint.continuation }),
        coveredResults: [...coveredResults.values()],
      },
      results: remainingResults,
    }),
  });
  return view
    ? bindRequestToolResultsMessage(view, projected.content)
    : projected;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function parseJsonRecord(content: string): Record<string, unknown> | undefined {
  try {
    return parseRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}
function readRecordArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = parseRecord(entry);
        return record ? [record] : [];
      })
    : [];
}
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
function resolveResultSource(
  result: Record<string, unknown>,
  _prefix: undefined,
  overrides: ReadonlyMap<string, SemanticCompactionSource>,
): SemanticCompactionSource | undefined {
  const executionId = readNonEmptyString(result.executionId);
  if (!executionId) return undefined;
  const override = overrides.get(executionId);
  if (override) return override;
  const content = JSON.stringify(result);
  return {
    sourceRef: executionId,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  };
}

/** Read aliases only from exact source bytes, including previously covered receipts. */
function projectCoveredResultSummary(
  receipt: Record<string, unknown>,
  source: SemanticCompactionSource | undefined,
  fingerprint: string,
): Record<string, unknown> {
  if (!source || source.sourceFingerprint !== fingerprint) return receipt;
  const canonical = parseJsonRecord(source.content);
  if (!canonical || canonical.executionId !== receipt.executionId)
    return receipt;
  if (typeof receipt.summary !== "string") return receipt;
  const adapter = parseRecord(canonical.adapterResult);
  const result =
    adapter?.kind === "registered_tool_execution_result_v1"
      ? parseRecord(adapter.result)
      : undefined;
  const output = typeof result?.output === "string" ? result.output : undefined;
  return {
    ...receipt,
    summary: projectCompactedRegisteredOutputSummary(receipt.summary, output),
  };
}
