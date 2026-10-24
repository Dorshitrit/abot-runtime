import { buildCheckpointMessage, type CheckpointProjectionOptions } from "./semantic-compaction/checkpoint-message.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "./semantic-compaction/evidence-scope.js";
import { readOperationSupervisionEvidenceBinding } from "./operation-supervision-evidence-binding.js";
import { CORE_SKILL_READ_MESSAGE_KIND, coreSkillReadSourceRef } from "./core-skill-read-context.js";
import { OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND } from "./operation-supervision-evidence.js";
import { projectRequestToolResultsCheckpointMessage } from "./request-tool-results-checkpoint.js";
import { CompactionSourceInvariantError } from "./compaction-source-invariant.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { SuperWorkerCompactionSidecar } from "./super-worker-compaction-sidecar.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionSource,
} from "./semantic-compaction/contracts.js";

type ScannedSource = Readonly<{
  index: number;
  source: SemanticCompactionSource;
}>;

const PAYLOAD_CONTEXT_PREFIX = "Canonical runtime context:\n";

export function projectCheckpointMessages(
  messages: readonly ChatMessage[],
  scopeId: string,
  checkpoint: SemanticCompactionCheckpoint,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
  superOwned = false,
  recordVerifiedProjection?: (message: ChatMessage) => void,
  options: CheckpointProjectionOptions = {},
): ChatMessage[] {
  const scanned = scanCompactionSources(
    messages,
    scopeId,
    resultSourceOverrides,
  );
  const covered = new Map(
    checkpoint.sourceDigests.map((source) => [source.sourceRef, source]),
  );
  const removable = new Set<number>();
  let insertionIndex = messages.length;
  const checkpointEmbedded = messages.some(isCheckpointCarrierMessage);
  for (const { index, source } of scanned) {
    const exact = covered.get(source.sourceRef);
    if (exact?.sourceFingerprint === source.sourceFingerprint) {
      if (!isCheckpointCarrierMessage(messages[index]!)) {
        removable.add(index);
        insertionIndex = Math.min(insertionIndex, index);
      }
    }
  }
  messages.forEach((message, index) => {
    if (
      isCheckpointMessage(message, scopeId) ||
      (options.replacesScopeId !== undefined &&
        isCheckpointMessage(message, options.replacesScopeId))
    ) {
      removable.add(index);
      insertionIndex = Math.min(insertionIndex, index);
    }
  });
  const checkpointMessage = buildCheckpointMessage(checkpoint, options);
  if (checkpoint.sourceDigests.length > 0 && !checkpointEmbedded)
    recordVerifiedProjection?.(checkpointMessage);
  const projected: ChatMessage[] = [];
  let inserted = false;
  messages.forEach((message, index) => {
    const requestToolResults = projectRequestToolResultsCheckpointMessage(
      message,
      checkpoint,
      resultSourceOverrides,
      options,
    );
    const payloadContext = projectPayloadContextCheckpointMessage(
      message,
      checkpoint,
      resultSourceOverrides,
      superOwned,
      options,
    );
    if (!checkpointEmbedded && !inserted && index === insertionIndex) {
      projected.push(checkpointMessage);
      inserted = true;
    }
    if (!removable.has(index)) {
      const carrier = requestToolResults ?? payloadContext;
      if (checkpoint.sourceDigests.length > 0 && carrier)
        recordVerifiedProjection?.(carrier);
      projected.push(requestToolResults ?? payloadContext ?? message);
    }
  });
  if (!checkpointEmbedded && !inserted) projected.push(checkpointMessage);
  return projected;
}

export function scanCompactionSources(
  messages: readonly ChatMessage[],
  scopeId: string,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
  sidecar?: SuperWorkerCompactionSidecar,
): readonly ScannedSource[] {
  const sources: ScannedSource[] = [];
  messages.forEach((message, index) => {
    if (
      isCheckpointMessage(message, scopeId) ||
      readOperationSupervisionEvidenceBinding(message)
    )
      return;
    for (const source of resolveMessageSources(
      message,
      resultSourceOverrides,
      sidecar,
    )) {
      sources.push(Object.freeze({ index, source }));
    }
  });
  return Object.freeze(sources);
}

function resolveMessageSources(
  message: ChatMessage,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
  sidecar?: SuperWorkerCompactionSidecar,
): readonly SemanticCompactionSource[] {
  if (message.role === "tool") {
    return Object.freeze([
      resultSourceOverrides.get(`tool-result:${message.toolCallId}`) ??
        createMessageSource(`tool-result:${message.toolCallId}`, message),
    ]);
  }
  if (message.role === "assistant" && message.toolCalls) {
    return Object.freeze([
      createMessageSource(
        `tool-action:${createSemanticCompactionSha256Fingerprint(
          message.toolCalls.map(({ callId }) => callId).join("\n"),
        ).slice("sha256:".length)}`,
        message,
      ),
    ]);
  }
  if (!message.content) return Object.freeze([]);
  const payloadContext = parsePayloadContextRecord(message.content);
  if (payloadContext) {
    return Object.freeze(
      readRecordArray(payloadContext.settledCapabilityResults).flatMap(
        (result) => {
          const source = resolveScannableResultSource(
            result,
            "payload-result",
            resultSourceOverrides,
            sidecar,
          );
          return source ? [source] : [];
        },
      ),
    );
  }
  const record = parseJsonRecord(message.content);
  if (record?.kind === CORE_SKILL_READ_MESSAGE_KIND) {
    const read = record.read as { readId?: unknown } | undefined;
    const document = record.document as { skillId?: unknown } | undefined;
    const readId = readNonEmptyString(read?.readId);
    return readId ? Object.freeze([createMessageSource(
      coreSkillReadSourceRef(readId, readNonEmptyString(document?.skillId)), message,
    )]) : Object.freeze([]);
  }
  if (record?.kind === OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND) {
    return Object.freeze([
      createMessageSource(
        hashedMessageSourceRef(
          "operation-supervision-evidence",
          message.content,
        ),
        message,
      ),
    ]);
  }
  if (record?.kind === "runtime_request_tool_results_v1") {
    return Object.freeze(
      readRecordArray(record.results).flatMap((result) => {
        const source = resolveScannableResultSource(
          result,
          undefined,
          resultSourceOverrides,
          sidecar,
        );
        return source ? [source] : [];
      }),
    );
  }
  if (record?.kind === "runtime_child_result") {
    const resultRef = readNonEmptyString(record.resultRef);
    return resultRef
      ? Object.freeze([
          createMessageSource(`child-result:${resultRef}`, message),
        ])
      : Object.freeze([]);
  }
  if (record?.kind === "runtime_execution_agent_auditor_evidence_v1") {
    return Object.freeze([
      createMessageSource(
        hashedMessageSourceRef("role-evidence", message.content),
        message,
      ),
    ]);
  }
  const header = parseJsonRecord(message.content.split("\n", 1)[0] ?? "");
  if (header?.kind === "runtime_reviewer_evidence_v1") {
    const evidenceRef = readNonEmptyString(header.evidenceRef);
    return Object.freeze([
      createMessageSource(
        evidenceRef
          ? `reviewer-evidence:${evidenceRef}`
          : hashedMessageSourceRef("reviewer-evidence", message.content),
        message,
      ),
    ]);
  }
  return Object.freeze([]);
}

function createMessageSource(
  sourceRef: string,
  message: ChatMessage,
): SemanticCompactionSource {
  const content = JSON.stringify(message);
  return Object.freeze({
    sourceRef,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  });
}

function hashedMessageSourceRef(prefix: string, content: string): string {
  return `${prefix}:${createSemanticCompactionSha256Fingerprint(content).slice(
    "sha256:".length,
  )}`;
}

function isCheckpointMessage(message: ChatMessage, scopeId: string): boolean {
  if (!message.content) return false;
  const record = parseJsonRecord(message.content);
  return (
    record?.kind === "runtime_semantic_compaction_checkpoint_v2" &&
    record.scopeId === scopeId
  );
}

function isCheckpointCarrierMessage(message: ChatMessage): boolean {
  return (
    parseJsonRecord(message.content)?.kind ===
      "runtime_request_tool_results_v1" ||
    parsePayloadContextRecord(message.content) !== undefined
  );
}

function projectPayloadContextCheckpointMessage(
  message: ChatMessage,
  checkpoint: SemanticCompactionCheckpoint,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
  superOwned: boolean,
  options: CheckpointProjectionOptions,
): ChatMessage | undefined {
  const context = parsePayloadContextRecord(message.content);
  if (!context) return undefined;
  if (message.role !== "user" || message.attachments?.length) {
    throw new Error("context_compaction_payload_context_invalid");
  }
  const previousProjection = parseRecord(context.semanticCheckpoint);
  const previousScopeId = readNonEmptyString(previousProjection?.scopeId);
  if (
    previousScopeId &&
    previousScopeId !== checkpoint.scopeId &&
    previousScopeId !== options.replacesScopeId
  ) {
    throw new Error("context_compaction_checkpoint_scope_conflict");
  }
  const covered = new Map(
    checkpoint.sourceDigests.map((source) => [source.sourceRef, source]),
  );
  const coveredResults = new Map<string, Record<string, unknown>>();
  for (const receipt of readRecordArray(previousProjection?.coveredResults)) {
    const executionId = readNonEmptyString(receipt.executionId);
    const fingerprint = readNonEmptyString(receipt.sourceFingerprint);
    const source = executionId
      ? resolveResultSource(receipt, "payload-result", resultSourceOverrides)
      : undefined;
    const exact = source ? covered.get(source.sourceRef) : undefined;
    if (
      !executionId ||
      !fingerprint ||
      exact?.sourceFingerprint !== fingerprint
    ) {
      throw new Error("context_compaction_checkpoint_receipt_invalid");
    }
    coveredResults.set(executionId, receipt);
  }
  const remainingResults: Record<string, unknown>[] = [];
  for (const result of readRecordArray(context.settledCapabilityResults)) {
    const executionId = readNonEmptyString(result.executionId);
    const source = resolveResultSource(
      result,
      "payload-result",
      resultSourceOverrides,
    );
    const exact = source ? covered.get(source.sourceRef) : undefined;
    if (!executionId || !source || !exact) {
      remainingResults.push(result);
      continue;
    }
    if (source.sourceFingerprint !== exact.sourceFingerprint) {
      if (superOwned) {
        throw new CompactionSourceInvariantError(
          "context_compaction_source_identity_conflict",
          source.sourceRef,
        );
      }
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
        ...receipt,
        sourceFingerprint: exact.sourceFingerprint,
      }),
    );
  }
  return Object.freeze({
    role: "user" as const,
    content: `${PAYLOAD_CONTEXT_PREFIX}${JSON.stringify({
      ...context,
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
        presenceEffect: options.includeContinuation === false
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
      settledCapabilityResults: remainingResults,
    })}`,
  });
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const decoded = JSON.parse(value) as unknown;
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function createResultSourceOverrideMap(
  sources: readonly SemanticCompactionSource[],
): ReadonlyMap<string, SemanticCompactionSource> {
  const overrides = new Map<string, SemanticCompactionSource>();
  for (const source of sources) {
    if (
      !source.sourceRef.trim() ||
      !source.content ||
      createSemanticCompactionSha256Fingerprint(source.content) !==
        source.sourceFingerprint ||
      overrides.has(source.sourceRef)
    ) {
      throw new Error("context_compaction_source_override_invalid");
    }
    overrides.set(source.sourceRef, source);
  }
  return overrides;
}

function resolveResultSource(
  result: Record<string, unknown>,
  sourceRefPrefix: string | undefined,
  overrides: ReadonlyMap<string, SemanticCompactionSource>,
): SemanticCompactionSource | undefined {
  const executionId = readNonEmptyString(result.executionId);
  if (!executionId) return undefined;
  const sourceRef = sourceRefPrefix
    ? `${sourceRefPrefix}:${executionId}`
    : executionId;
  const override = overrides.get(executionId) ?? overrides.get(sourceRef);
  if (override) return override;
  const content = JSON.stringify(result);
  return Object.freeze({
    sourceRef,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  });
}

/**
 * A summary-only receipt is a passive index entry, not a second representation
 * of the exact evidence body. Only exact evidence (or a canonical override)
 * can become a semantic-compaction source.
 */
function resolveScannableResultSource(
  result: Record<string, unknown>,
  sourceRefPrefix: string | undefined,
  overrides: ReadonlyMap<string, SemanticCompactionSource>,
  sidecar?: SuperWorkerCompactionSidecar,
): SemanticCompactionSource | undefined {
  const executionId = readNonEmptyString(result.executionId);
  if (!executionId) return undefined;
  if (sidecar && !sidecar.eligibleExecutionIds.includes(executionId))
    return undefined;
  const sourceRef = sourceRefPrefix
    ? `${sourceRefPrefix}:${executionId}`
    : executionId;
  if (
    !overrides.has(executionId) &&
    !overrides.has(sourceRef) &&
    !readNonEmptyString(result.referenceData) &&
    !parseRecord(result.adapterResult)
  ) {
    return undefined;
  }
  return resolveResultSource(result, sourceRefPrefix, overrides);
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsePayloadContextRecord(
  value: string,
): Record<string, unknown> | undefined {
  return value.startsWith(PAYLOAD_CONTEXT_PREFIX)
    ? parseJsonRecord(value.slice(PAYLOAD_CONTEXT_PREFIX.length))
    : undefined;
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
