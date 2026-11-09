import type { ChatMessage } from "../../model-gateway/types.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import { projectCanonicalRequestToolResult } from "./canonical-capability-result.js";
import { createCapabilityResultCompactionSource } from "./capability-result-compaction-source.js";
import { CompactionSourceInvariantError } from "./compaction-source-invariant.js";
import { projectCheckpointMessages, scanCompactionSources } from "./model-step-compaction-projection.js";
import { buildRequestToolResultsMessage, type RequestToolResult, type RequestToolResultsView } from "./request-tool-results.js";
import { bindRequestToolResultsMessage } from "./request-tool-results-message-binding.js";
import { projectRequestToolResultsCheckpointMessage } from "./request-tool-results-checkpoint.js";
import { buildCheckpointMessage } from "./semantic-compaction/checkpoint-message.js";
import type { SemanticCompactionCheckpoint, SemanticCompactionSource } from "./semantic-compaction/contracts.js";
import type { SemanticCompactionRequest } from "./semantic-compaction/generation-contracts.js";
import { assertSuperCompactionCheckpointIntegrity } from "./semantic-compaction/super-source-integrity.js";
import {
  createSupervisorReceiptCompactionSource,
  isSupervisorReceiptExecutionEligible,
  projectSupervisorReceipt,
} from "./semantic-compaction/supervisor-receipt-source.js";
import { hasSuperContextContract } from "./super-context-policy.js";

type CompactionProjection = Readonly<{
  scanCompactionSources: typeof scanCompactionSources;
  projectCheckpointMessages: typeof projectCheckpointMessages;
}>;
export type SupervisorToolEvidence = Readonly<{
  buildMessages(): readonly ChatMessage[];
  compaction: CompactionProjection;
  hasVerifiedCompactedEvidence(messages: readonly ChatMessage[]): boolean;
}>;
type EvidenceRequest = Pick<SemanticCompactionRequest, "requestId" | "prompt" | "contextCompactionStore">;
type EvidenceInput = Readonly<{
  head?: RoleCallLedgerHead;
  callId: string;
  toolResults: RequestToolResultsView;
}>;
type VisibleReceipt = Readonly<{
  receipt: RequestToolResult;
  source: SemanticCompactionSource;
  canonicalSource: SemanticCompactionSource;
  aliasesOutput: boolean;
}>;
type ReusedDigest = Readonly<{
  checkpoint: SemanticCompactionCheckpoint;
  digest: SemanticCompactionCheckpoint["sourceDigests"][number];
}>;
type ReceiptRecord = Readonly<Record<string, unknown>>;
type CarrierRecord = Readonly<Record<string, unknown> & { results: readonly ReceiptRecord[] }>;
type Carrier = Readonly<{
  record: CarrierRecord;
  sources: ReadonlyMap<string, SemanticCompactionSource>;
}>;

/** Invocation-local parent evidence; canonical receipts and checkpoints remain unchanged. */
export function createSupervisorToolEvidence(
  request: EvidenceRequest,
  input: EvidenceInput,
): SupervisorToolEvidence | undefined {
  const { head, toolResults } = input;
  const store = request.contextCompactionStore;
  if (!head || !store) return undefined;
  if (!hasSuperContextContract(head.policy.authority, "supervisor")) return undefined;
  if (input.callId !== head.state.rootCallId) return undefined;
  if (head.state.requestId !== request.requestId || toolResults.sourceRevision !== head.revision)
    throw new Error("supervisor_tool_evidence_binding_invalid");

  const original = buildRequestToolResultsMessage(toolResults);
  const record = JSON.parse(original.content) as CarrierRecord;
  const receipts = resolveVisibleReceipts(head, input.callId, record.results);
  if (receipts.size === 0) return undefined;
  const integrity = { requestId: request.requestId, prompt: request.prompt, head, store };
  const previous = store.get(`role:supervisor:${input.callId}:continuation`);
  if (previous) assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint: previous });
  const reused = resolveReusedDigests(integrity, receipts, previous);
  const passiveMessages = buildPassiveMessages(reused);
  const carriers = new WeakMap<ChatMessage, Carrier>();
  const remaining = new Map<string, SemanticCompactionSource>();
  const results = record.results.map((receipt) => {
    const executionId = receipt.executionId;
    if (typeof executionId !== "string") return receipt;
    const selected = receipts.get(executionId);
    if (!selected) return receipt;
    const covered = reused.get(executionId);
    if (covered) return projectCoveredReceipt(receipt, covered.digest, covered.checkpoint.scopeId);
    remaining.set(executionId, selected.source);
    return receipt;
  });
  const bindCarrier = (carrier: Carrier): ChatMessage => {
    const message = bindRequestToolResultsMessage(toolResults, JSON.stringify(carrier.record));
    carriers.set(message, carrier);
    return message;
  };
  const initial = bindCarrier({ record: { ...record, results }, sources: remaining });
  const messages = Object.freeze([...passiveMessages, initial]);
  const compaction = createParentCompactionProjection(carriers, bindCarrier);

  return Object.freeze({
    buildMessages: () => messages,
    compaction,
    hasVerifiedCompactedEvidence(candidate: readonly ChatMessage[]) {
      if (passiveMessages.length === 0) return false;
      if (!passiveMessages.every((message) => candidate.includes(message))) return false;
      return candidate.some((message) => carriers.has(message));
    },
  });
}

/** Superseded summaries and other display projections never resurrect canonical bodies. */
function resolveVisibleReceipts(
  head: RoleCallLedgerHead,
  callId: string,
  visible: readonly ReceiptRecord[],
): ReadonlyMap<string, VisibleReceipt> {
  const receipts = new Map<string, VisibleReceipt>();
  for (const row of visible) {
    if (typeof row.executionId !== "string") continue;
    const input = { head, consumerCallId: callId, executionId: row.executionId };
    if (!isSupervisorReceiptExecutionEligible(input)) continue;
    const receipt = projectSupervisorReceipt(input);
    if (JSON.stringify(row) !== JSON.stringify(receipt)) continue;
    const execution = head.state.capabilityExecutions.find((entry) => entry.executionId === receipt.executionId)!;
    const canonical = projectCanonicalRequestToolResult(head, execution);
    receipts.set(receipt.executionId, Object.freeze({
      receipt,
      source: createSupervisorReceiptCompactionSource(input),
      canonicalSource: createCapabilityResultCompactionSource(canonical),
      aliasesOutput: isRegisteredOutputSummaryAlias(canonical),
    }));
  }
  return receipts;
}

function isRegisteredOutputSummaryAlias(result: RequestToolResult): boolean {
  if (result.adapterResult?.kind !== "registered_tool_execution_result_v1") return false;
  const output = result.adapterResult.result.output;
  if (result.summary === output) return true;
  return result.summary === output.trim();
}

/** A child's own immutable evidence is reused only for its parent's visible alias. */
function resolveReusedDigests(
  integrity: Omit<Parameters<typeof assertSuperCompactionCheckpointIntegrity>[0], "checkpoint">,
  receipts: ReadonlyMap<string, VisibleReceipt>,
  previous: SemanticCompactionCheckpoint | undefined,
): ReadonlyMap<string, ReusedDigest> {
  const reused = new Map<string, ReusedDigest>();
  const previousCoverage = new Map(previous?.sourceDigests.map((digest) => [digest.sourceRef, digest.sourceFingerprint]) ?? []);
  const callIds = [...new Set([...receipts.values()].map(({ receipt }) => receipt.callId))];
  for (const checkpoint of integrity.store.findByCallIds(callIds)) {
    assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint });
    for (const digest of checkpoint.sourceDigests) {
      const visible = receipts.get(digest.sourceRef);
      if (!canReuseVisibleDigest(visible, digest, previousCoverage)) continue;
      if (reused.has(digest.sourceRef)) continue;
      reused.set(digest.sourceRef, Object.freeze({ checkpoint, digest }));
    }
  }
  return reused;
}

function canReuseVisibleDigest(
  visible: VisibleReceipt | undefined,
  digest: SemanticCompactionCheckpoint["sourceDigests"][number],
  previous: ReadonlyMap<string, string>,
): visible is VisibleReceipt {
  if (!visible?.aliasesOutput) return false;
  if (previous.get(visible.source.sourceRef) === visible.source.sourceFingerprint) return false;
  return digest.sourceFingerprint === visible.canonicalSource.sourceFingerprint;
}

function buildPassiveMessages(reused: ReadonlyMap<string, ReusedDigest>): readonly ChatMessage[] {
  const groups = new Map<SemanticCompactionCheckpoint, SemanticCompactionCheckpoint["sourceDigests"][number][]>();
  for (const { checkpoint, digest } of reused.values()) {
    const selected = groups.get(checkpoint) ?? [];
    selected.push(digest);
    groups.set(checkpoint, selected);
  }
  return Object.freeze([...groups].map(([checkpoint, sourceDigests]) =>
    buildCheckpointMessage({ ...checkpoint, sourceDigests }, { includeContinuation: false })));
}

function projectCoveredReceipt(
  receipt: ReceiptRecord,
  source: Pick<SemanticCompactionSource, "sourceRef" | "sourceFingerprint">,
  scopeId: string,
): ReceiptRecord {
  const { summary: _summary, ...identity } = receipt;
  return Object.freeze({
    ...identity,
    sourceRef: source.sourceRef,
    sourceFingerprint: source.sourceFingerprint,
    checkpointScopeId: scopeId,
  });
}

function createParentCompactionProjection(
  carriers: WeakMap<ChatMessage, Carrier>,
  bindCarrier: (carrier: Carrier) => ChatMessage,
): CompactionProjection {
  return Object.freeze({
    scanCompactionSources(messages, scopeId, overrides, sidecar) {
      const sources = new Map<string, ReturnType<typeof scanCompactionSources>[number]>();
      for (const [index, message] of messages.entries()) {
        const carrier = carriers.get(message);
        const selected = [
          ...(carrier?.sources.values() ?? []),
          ...scanCompactionSources([message], scopeId, overrides, sidecar).map(({ source }) => source),
        ];
        for (const source of selected) {
          const previous = sources.get(source.sourceRef);
          if (hasConflictingSource(previous?.source, source))
            throw new CompactionSourceInvariantError("context_compaction_source_identity_conflict", source.sourceRef);
          if (!previous) sources.set(source.sourceRef, Object.freeze({ index, source }));
        }
      }
      return Object.freeze([...sources.values()]);
    },
    projectCheckpointMessages(...args) {
      return projectParentCheckpointMessages(args, carriers, bindCarrier);
    },
  });
}

function hasConflictingSource(previous: SemanticCompactionSource | undefined, source: SemanticCompactionSource): boolean {
  if (!previous) return false;
  if (previous.sourceFingerprint !== source.sourceFingerprint) return true;
  return previous.content !== source.content;
}

/** Keep the parent's receipt carrier separate from MAIN's single-checkpoint carrier. */
function projectParentCheckpointMessages(
  [messages, scopeId, checkpoint, overrides, superOwned, recordVerifiedProjection, options]: Parameters<typeof projectCheckpointMessages>,
  carriers: WeakMap<ChatMessage, Carrier>,
  bindCarrier: (carrier: Carrier) => ChatMessage,
): ChatMessage[] {
  const placeholders = new Map<ChatMessage, ChatMessage>();
  const masked = messages.map((message) => {
    if (!carriers.has(message)) return message;
    const placeholder = Object.freeze({ role: "user" as const, content: "" });
    placeholders.set(placeholder, message);
    return placeholder;
  });
  const verified: ChatMessage[] = [];
  const projected = projectCheckpointMessages(
    masked, scopeId, checkpoint, overrides, superOwned,
    recordVerifiedProjection ? (message) => verified.push(message) : undefined,
    options,
  );
  const replacements = new Map<ChatMessage, ChatMessage>();
  const result = projected.map((message) => {
    const original = placeholders.get(message);
    if (!original) return message;
    const carrier = carriers.get(original)!;
    const replacement = projectParentCarrier(carrier, checkpoint, overrides, options);
    if (!replacement) return original;
    const bound = bindCarrier(replacement);
    replacements.set(original, bound);
    return bound;
  });
  placeParentCheckpointBeforeReceipts(result, scopeId, carriers);
  for (const message of verified) recordVerifiedProjection?.(replacements.get(message) ?? message);
  return result;
}

function projectParentCarrier(
  carrier: Carrier,
  checkpoint: SemanticCompactionCheckpoint,
  overrides: ReadonlyMap<string, SemanticCompactionSource>,
  options: Parameters<typeof projectCheckpointMessages>[6],
): Carrier | undefined {
  const covered = new Map(checkpoint.sourceDigests.map((digest) => [digest.sourceRef, digest]));
  const ordinary = projectOrdinaryCoveredReceipts(carrier, checkpoint, overrides, options);
  const remaining = new Map(carrier.sources);
  const results = carrier.record.results.map((receipt) => {
    if (typeof receipt.executionId !== "string") return receipt;
    const source = remaining.get(receipt.executionId);
    if (!source) return ordinary.get(receipt.executionId) ?? receipt;
    const digest = covered.get(source.sourceRef);
    if (!digest) return receipt;
    if (digest.sourceFingerprint !== source.sourceFingerprint)
      throw new CompactionSourceInvariantError("context_compaction_source_identity_conflict", source.sourceRef);
    remaining.delete(receipt.executionId);
    return projectCoveredReceipt(receipt, digest, checkpoint.scopeId);
  });
  if (remaining.size === carrier.sources.size && ordinary.size === 0) return undefined;
  return Object.freeze({ record: { ...carrier.record, results }, sources: remaining });
}

/** Root-owned exact results retain MAIN's source and covered-receipt semantics. */
function projectOrdinaryCoveredReceipts(
  carrier: Carrier,
  checkpoint: SemanticCompactionCheckpoint,
  overrides: ReadonlyMap<string, SemanticCompactionSource>,
  options: Parameters<typeof projectCheckpointMessages>[6],
): ReadonlyMap<string, ReceiptRecord> {
  const results = carrier.record.results.filter((receipt) =>
    !isPreviouslyCoveredParentReceipt(receipt, checkpoint));
  const message = projectRequestToolResultsCheckpointMessage(
    { role: "user", content: JSON.stringify({ ...carrier.record, results }) }, checkpoint, overrides, options,
  );
  if (!message) return new Map();
  const projected = JSON.parse(message.content) as {
    semanticCheckpoint: { coveredResults: readonly ReceiptRecord[] };
  };
  const receipts = new Map<string, ReceiptRecord>();
  for (const receipt of projected.semanticCheckpoint.coveredResults) {
    if (typeof receipt.executionId !== "string") continue;
    receipts.set(receipt.executionId, Object.freeze({
      ...receipt,
      sourceRef: receipt.executionId,
      checkpointScopeId: checkpoint.scopeId,
    }));
  }
  return receipts;
}

/** Coverage fields are trusted only on this invocation's privately bound carrier. */
function isPreviouslyCoveredParentReceipt(
  receipt: ReceiptRecord,
  checkpoint: SemanticCompactionCheckpoint,
): boolean {
  if (receipt.checkpointScopeId !== checkpoint.scopeId) return false;
  if (typeof receipt.sourceRef !== "string") return false;
  if (typeof receipt.sourceFingerprint !== "string") return false;
  const source = checkpoint.sourceDigests.find((digest) => digest.sourceRef === receipt.sourceRef);
  if (source?.sourceFingerprint !== receipt.sourceFingerprint)
    throw new CompactionSourceInvariantError("context_compaction_source_identity_conflict", receipt.sourceRef);
  return true;
}

function placeParentCheckpointBeforeReceipts(
  messages: ChatMessage[],
  scopeId: string,
  carriers: WeakMap<ChatMessage, Carrier>,
): void {
  const anchor = messages.findIndex((message) => carriers.has(message));
  if (anchor < 0) return;
  const checkpointIndex = messages.findIndex((message) => {
    if (message.role !== "user") return false;
    try {
      const record = JSON.parse(message.content) as Record<string, unknown>;
      return record.kind === "runtime_semantic_compaction_checkpoint_v2" && record.scopeId === scopeId;
    } catch {
      return false;
    }
  });
  if (checkpointIndex <= anchor) return;
  const [checkpoint] = messages.splice(checkpointIndex, 1);
  messages.splice(anchor, 0, checkpoint!);
}
