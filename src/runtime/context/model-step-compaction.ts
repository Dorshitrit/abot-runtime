import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import type { ModelStepContextCompactionController } from "../model/model-step-port.js";
import {
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  assertValidSemanticCompactionCheckpoint,
  createSemanticCompactionSha256Fingerprint,
  generateSemanticCompactionCandidateBatched,
  sameSemanticCompactionCheckpointBinding,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionCheckpointBinding,
  type SemanticCompactionSource,
  type SemanticCompactionRequest,
} from "./semantic-compaction/index.js";

type ModelStepCompactionOptions = Readonly<{
  call: Readonly<{ roleId: string; callId: string; objective: string | null }>;
  sourceRevision: number;
  allowedConsumers: readonly ModelStep[];
  scopeId?: string;
  scopeSuffix?: string;
  resultSourceOverrides?: readonly SemanticCompactionSource[];
}>;

type ScannedSource = Readonly<{
  index: number;
  source: SemanticCompactionSource;
}>;

const PAYLOAD_CONTEXT_PREFIX = "Canonical runtime context:\n";

export function createModelStepCompactionController(
  request: SemanticCompactionRequest,
  options: ModelStepCompactionOptions,
): ModelStepContextCompactionController {
  if (!options.call.objective) {
    throw new Error("context_compaction_active_objective_required");
  }
  const scopeId =
    options.scopeId ??
    [
      "role",
      options.call.roleId,
      options.call.callId,
      options.scopeSuffix ?? "continuation",
    ].join(":");
  const binding: SemanticCompactionCheckpointBinding = Object.freeze({
    requestId: request.requestId,
    currentRequestFingerprint: createSemanticCompactionSha256Fingerprint(
      request.prompt,
    ),
    roleId: options.call.roleId,
    callId: options.call.callId,
    objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
      options.call.objective,
    ),
    contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
    allowedConsumers: Object.freeze([...options.allowedConsumers]),
  });
  const store = request.contextCompactionStore;
  if (!store) {
    throw new Error("context_compaction_store_required");
  }
  const resultSourceOverrides = createResultSourceOverrideMap(
    options.resultSourceOverrides ?? [],
  );

  const readPrevious = (): SemanticCompactionCheckpoint | undefined => {
    const previous = store.get(scopeId);
    if (!previous) return undefined;
    assertValidSemanticCompactionCheckpoint(previous);
    if (!sameSemanticCompactionCheckpointBinding(previous, binding)) {
      throw new Error("context_compaction_checkpoint_not_applicable");
    }
    return previous;
  };

  return Object.freeze({
    compactionScope: "active_request" as const,
    project(messages) {
      const previous = readPrevious();
      return previous
        ? projectCheckpointMessages(
            messages,
            scopeId,
            previous,
            resultSourceOverrides,
          )
        : [...messages];
    },
    async prepare(messages) {
      const previous = readPrevious();
      const scanned = scanCompactionSources(
        messages,
        scopeId,
        resultSourceOverrides,
      );
      const covered = new Map(
        previous?.sourceDigests.map((source) => [source.sourceRef, source]) ??
          [],
      );
      const newSources = scanned
        .map(({ source }) => source)
        .filter((source) => {
          const existing = covered.get(source.sourceRef);
          if (!existing) return true;
          if (existing.sourceFingerprint !== source.sourceFingerprint) {
            throw new Error("context_compaction_source_identity_conflict");
          }
          return false;
        });
      if (newSources.length === 0) {
        if (!previous) {
          throw new Error("context_compaction_sources_empty");
        }
        return Object.freeze({
          messages: projectCheckpointMessages(
            messages,
            scopeId,
            previous,
            resultSourceOverrides,
          ),
          commit() {},
          scopeId,
          sourceRevision: previous.sourceRevision,
          coveredSourceCount: previous.sourceDigests.length,
        });
      }
      const candidate = await generateSemanticCompactionCandidateBatched({
        request,
        scopeId,
        binding,
        sourceRevision: options.sourceRevision,
        preservationObjective: options.call.objective!,
        ...(previous ? { previous } : {}),
        sources: newSources,
      });
      return Object.freeze({
        messages: projectCheckpointMessages(
          messages,
          scopeId,
          candidate,
          resultSourceOverrides,
        ),
        commit() {
          store.commit(candidate);
        },
        scopeId,
        sourceRevision: candidate.sourceRevision,
        coveredSourceCount: candidate.sourceDigests.length,
      });
    },
  });
}

function projectCheckpointMessages(
  messages: readonly ChatMessage[],
  scopeId: string,
  checkpoint: SemanticCompactionCheckpoint,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
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
    if (isCheckpointMessage(message, scopeId)) {
      removable.add(index);
      insertionIndex = Math.min(insertionIndex, index);
    }
  });
  const checkpointMessage = buildCheckpointMessage(checkpoint);
  const projected: ChatMessage[] = [];
  let inserted = false;
  messages.forEach((message, index) => {
    const requestToolResults = projectRequestToolResultsCheckpointMessage(
      message,
      checkpoint,
      resultSourceOverrides,
    );
    const payloadContext = projectPayloadContextCheckpointMessage(
      message,
      checkpoint,
      resultSourceOverrides,
    );
    if (!checkpointEmbedded && !inserted && index === insertionIndex) {
      projected.push(checkpointMessage);
      inserted = true;
    }
    if (!removable.has(index)) {
      projected.push(requestToolResults ?? payloadContext ?? message);
    }
  });
  if (!checkpointEmbedded && !inserted) projected.push(checkpointMessage);
  return projected;
}

function buildCheckpointMessage(
  checkpoint: SemanticCompactionCheckpoint,
): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: checkpoint.kind,
      authority: "runtime_role_continuation",
      presenceEffect:
        "passive_continuity_not_user_intent_routing_or_completion",
      scopeId: checkpoint.scopeId,
      roleId: checkpoint.roleId,
      callId: checkpoint.callId,
      sourceRevision: checkpoint.sourceRevision,
      coveredSources: checkpoint.sourceDigests.map(
        ({ sourceRef, sourceFingerprint, digest }) => ({
          sourceRef,
          sourceFingerprint,
          digest,
        }),
      ),
      continuation: checkpoint.continuation,
    }),
  });
}

function scanCompactionSources(
  messages: readonly ChatMessage[],
  scopeId: string,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
): readonly ScannedSource[] {
  const sources: ScannedSource[] = [];
  messages.forEach((message, index) => {
    if (isCheckpointMessage(message, scopeId)) return;
    for (const source of resolveMessageSources(
      message,
      resultSourceOverrides,
    )) {
      sources.push(Object.freeze({ index, source }));
    }
  });
  return Object.freeze(sources);
}

function resolveMessageSources(
  message: ChatMessage,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
): readonly SemanticCompactionSource[] {
  if (message.role === "tool") {
    return Object.freeze([
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
          );
          return source ? [source] : [];
        },
      ),
    );
  }
  const record = parseJsonRecord(message.content);
  if (record?.kind === "runtime_request_tool_results_v1") {
    return Object.freeze(
      readRecordArray(record.results).flatMap((result) => {
        const source = resolveScannableResultSource(
          result,
          undefined,
          resultSourceOverrides,
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
  if (
    record?.kind === "runtime_execution_agent_auditor_evidence_v1"
  ) {
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

function projectRequestToolResultsCheckpointMessage(
  message: ChatMessage,
  checkpoint: SemanticCompactionCheckpoint,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
): ChatMessage | undefined {
  const record = parseJsonRecord(message.content);
  if (record?.kind !== "runtime_request_tool_results_v1") return undefined;
  if (message.role !== "user" || message.attachments?.length) {
    throw new Error("context_compaction_request_tool_results_invalid");
  }
  const previousProjection = parseRecord(record.semanticCheckpoint);
  const previousScopeId = readNonEmptyString(previousProjection?.scopeId);
  if (previousScopeId && previousScopeId !== checkpoint.scopeId) {
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
      ? resolveResultSource(receipt, undefined, resultSourceOverrides)
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
    content: JSON.stringify({
      ...record,
      semanticCheckpoint: {
        kind: checkpoint.kind,
        scopeId: checkpoint.scopeId,
        roleId: checkpoint.roleId,
        callId: checkpoint.callId,
        checkpointSourceRevision: checkpoint.sourceRevision,
        presenceEffect:
          "passive_role_continuation_not_user_intent_or_completion",
        coveredSources: checkpoint.sourceDigests.map(
          ({ sourceRef, sourceFingerprint, digest }) => ({
            sourceRef,
            sourceFingerprint,
            digest,
          }),
        ),
        continuation: checkpoint.continuation,
        coveredResults: [...coveredResults.values()],
      },
      results: remainingResults,
    }),
  });
}

function projectPayloadContextCheckpointMessage(
  message: ChatMessage,
  checkpoint: SemanticCompactionCheckpoint,
  resultSourceOverrides: ReadonlyMap<string, SemanticCompactionSource>,
): ChatMessage | undefined {
  const context = parsePayloadContextRecord(message.content);
  if (!context) return undefined;
  if (message.role !== "user" || message.attachments?.length) {
    throw new Error("context_compaction_payload_context_invalid");
  }
  const previousProjection = parseRecord(context.semanticCheckpoint);
  const previousScopeId = readNonEmptyString(previousProjection?.scopeId);
  if (previousScopeId && previousScopeId !== checkpoint.scopeId) {
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
        scopeId: checkpoint.scopeId,
        roleId: checkpoint.roleId,
        callId: checkpoint.callId,
        checkpointSourceRevision: checkpoint.sourceRevision,
        presenceEffect:
          "passive_role_continuation_not_user_intent_or_completion",
        coveredSources: checkpoint.sourceDigests.map(
          ({ sourceRef, sourceFingerprint, digest }) => ({
            sourceRef,
            sourceFingerprint,
            digest,
          }),
        ),
        continuation: checkpoint.continuation,
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

function createResultSourceOverrideMap(
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
  const override = overrides.get(executionId);
  if (override) return override;
  const content = JSON.stringify(result);
  return Object.freeze({
    sourceRef: sourceRefPrefix
      ? `${sourceRefPrefix}:${executionId}`
      : executionId,
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
): SemanticCompactionSource | undefined {
  const executionId = readNonEmptyString(result.executionId);
  if (!executionId) return undefined;
  if (
    !overrides.has(executionId) &&
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
