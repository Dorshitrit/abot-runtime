import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RoleCallFrame, RoleCallLedgerHead, RoleCallResult } from "../../orchestration/role-calls/contracts.js";
import { CompactionSourceInvariantError } from "../compaction-source-invariant.js";
import { hasSuperContextContract } from "../super-context-policy.js";
import type { SuperWorkerCompactionSidecar } from "../super-worker-compaction-sidecar.js";
import { createSemanticCompactionSha256Fingerprint as hash, type SemanticCompactionCheckpoint, type SemanticCompactionSource } from "./contracts.js";

const SOURCE_PREFIX = "dependency-result:";
const SOURCE_KIND = "runtime_dependency_result_v1";
const COMPACTED_SUMMARY = "Role result evidence is available in the verified compacted source.";
const PAYLOAD_PREFIX = "Canonical runtime context:\n";
const CARRIER_KINDS = new Set([
  "runtime_worker_assignment", "runtime_worker_capability_execution_assignment", "runtime_worker_result_assignment",
]);
type JsonRecord = Record<string, unknown>;
type Carrier = Readonly<{ prefix: string; record: JsonRecord; dependencies: readonly JsonRecord[] }>;

export function dependencyResultSourceRef(resultRef: string): string {
  return SOURCE_PREFIX + resultRef;
}

export function isDependencyResultSource(source: SemanticCompactionSource): boolean {
  return source.sourceRef.startsWith(SOURCE_PREFIX);
}

/** Immutable result bytes have one identity independent of the selected consumer. */
export function createDependencyResultSource(result: RoleCallResult): SemanticCompactionSource {
  const content = JSON.stringify({ kind: SOURCE_KIND, authority: "reference_data",
    resultRef: result.resultRef, producerCallId: result.producerCallId, roleId: result.roleId,
    outcome: result.outcome, ...(result.steeringVersion !== undefined ? { steeringVersion: result.steeringVersion } : {}),
    summary: result.summary, ...(result.receipt ? { receipt: result.receipt } : {}),
  });
  return Object.freeze({ sourceRef: dependencyResultSourceRef(result.resultRef), sourceFingerprint: hash(content), content });
}

/** No active-call requirement: restoration also verifies completed historical consumers. */
export function projectSelectedDependencyResultSources(head: RoleCallLedgerHead, call: RoleCallFrame): readonly SemanticCompactionSource[] {
  if (!hasSuperContextContract(head.policy.authority, "delegated.worker") || call.roleId !== "worker") return [];
  if (!head.state.calls.includes(call)) throw new Error("context_compaction_dependency_consumer_invalid");
  return Object.freeze(call.dependencyResultRefs.map((resultRef) => {
    const result = requireSelectedDependencyResult(head, call, resultRef);
    return createDependencyResultSource(result);
  }));
}

export function assertDependencyResultSource(params: Readonly<{
  source: SemanticCompactionSource; head: RoleCallLedgerHead; scopeCall?: RoleCallFrame;
}>): void {
  const { source, head, scopeCall } = params;
  const record = parseRecord(source.content);
  if (record?.kind !== SOURCE_KIND || typeof record.resultRef !== "string" ||
      source.sourceRef !== dependencyResultSourceRef(record.resultRef))
    throw new CompactionSourceInvariantError("context_compaction_dependency_source_invalid", source.sourceRef);
  const consumers = scopeCall ? [scopeCall] : head.state.calls;
  const consumer = consumers.find((call) => call.roleId === "worker" &&
    head.state.calls.includes(call) && call.dependencyResultRefs.includes(record.resultRef as string));
  if (!consumer || !hasSuperContextContract(head.policy.authority, "delegated.worker"))
    throw new CompactionSourceInvariantError("context_compaction_dependency_source_unselected", source.sourceRef);
  const canonical = createDependencyResultSource(requireSelectedDependencyResult(head, consumer, record.resultRef));
  if (canonical.content !== source.content || canonical.sourceFingerprint !== source.sourceFingerprint)
    throw new CompactionSourceInvariantError("context_compaction_dependency_source_changed", source.sourceRef);
}

function requireSelectedDependencyResult(head: RoleCallLedgerHead, call: RoleCallFrame, resultRef: string): RoleCallResult {
  const result = head.state.results.find((candidate) => candidate.resultRef === resultRef);
  const producer = head.state.calls.find((candidate) => candidate.callId === result?.producerCallId);
  if (!call.dependencyResultRefs.includes(resultRef) || !result || !producer ||
      producer.parentCallId !== call.parentCallId || producer.status !== "completed" ||
      producer.resultRef !== resultRef || producer.roleId !== result.roleId)
    throw new CompactionSourceInvariantError("context_compaction_dependency_lineage_invalid", dependencyResultSourceRef(resultRef));
  return result;
}

/** Only a canonical SUPER sidecar makes dependency-shaped input scannable. */
export function scanDependencyResultSources(
  message: ChatMessage, overrides: ReadonlyMap<string, SemanticCompactionSource>, sidecar: SuperWorkerCompactionSidecar,
): readonly SemanticCompactionSource[] {
  const carrier = readCarrier(message);
  if (!carrier) return [];
  const sources = new Map<string, SemanticCompactionSource>();
  for (const dependency of carrier.dependencies) {
    if (typeof dependency.resultRef !== "string") continue;
    const source = requireVisibleDependencySource(dependency, overrides);
    if (!sidecar.sources.some((candidate) => candidate.sourceRef === source.sourceRef && candidate.content === source.content))
      throw new CompactionSourceInvariantError("context_compaction_dependency_source_unselected", source.sourceRef);
    if (dependency.summaryProjection !== undefined) continue;
    sources.set(source.sourceRef, source);
  }
  return [...sources.values()];
}

/** The digest stays in its existing checkpoint lane; the assignment retains a reference. */
export function projectDependencyResultCheckpointMessage(
  message: ChatMessage, checkpoint: SemanticCompactionCheckpoint, overrides: ReadonlyMap<string, SemanticCompactionSource>,
): ChatMessage | undefined {
  if (message.role !== "user") return undefined;
  const carrier = readCarrier(message);
  if (!carrier) return undefined;
  const covered = new Map(checkpoint.sourceDigests.map((digest) => [digest.sourceRef, digest.sourceFingerprint]));
  let changed = false;
  const dependencyResults = carrier.dependencies.map((dependency) => {
    if (typeof dependency.resultRef !== "string") return dependency;
    const source = requireVisibleDependencySource(dependency, overrides);
    const fingerprint = covered.get(source.sourceRef);
    if (fingerprint === undefined && dependency.summaryProjection !== undefined)
      throw new CompactionSourceInvariantError("context_compaction_dependency_checkpoint_missing", source.sourceRef);
    if (fingerprint === undefined) return dependency;
    if (fingerprint !== source.sourceFingerprint)
      throw new CompactionSourceInvariantError("context_compaction_dependency_checkpoint_mismatch", source.sourceRef);
    changed = true;
    return { ...dependency, summary: COMPACTED_SUMMARY, summaryProjection: {
      kind: "semantic_checkpoint", scopeId: checkpoint.scopeId,
      sourceRef: source.sourceRef, sourceFingerprint: source.sourceFingerprint,
      omissionMeaning: "partial_summary_not_original_body_or_completion",
    } };
  });
  if (!changed) return undefined;
  return Object.freeze({ ...message, content: carrier.prefix + JSON.stringify({ ...carrier.record, dependencyResults }) });
}

function requireVisibleDependencySource(dependency: JsonRecord, overrides: ReadonlyMap<string, SemanticCompactionSource>): SemanticCompactionSource {
  const sourceRef = dependencyResultSourceRef(dependency.resultRef as string);
  const source = overrides.get(sourceRef);
  const canonical = source ? parseRecord(source.content) : undefined;
  if (!source || canonical?.kind !== SOURCE_KIND || canonical.resultRef !== dependency.resultRef ||
      canonical.producerCallId !== dependency.producerCallId || canonical.roleId !== dependency.roleId ||
      canonical.outcome !== dependency.outcome)
    throw new CompactionSourceInvariantError("context_compaction_dependency_source_changed", sourceRef);
  if (dependency.summaryProjection === undefined && dependency.summary !== canonical.summary)
    throw new CompactionSourceInvariantError("context_compaction_dependency_source_changed", sourceRef);
  if (dependency.summaryProjection === undefined) return source;
  const projection = asRecord(dependency.summaryProjection);
  if (dependency.summary !== COMPACTED_SUMMARY || projection?.kind !== "semantic_checkpoint" ||
      typeof projection.scopeId !== "string" || projection.sourceRef !== sourceRef ||
      projection.sourceFingerprint !== source.sourceFingerprint)
    throw new CompactionSourceInvariantError("context_compaction_dependency_projection_invalid", sourceRef);
  return source;
}

function readCarrier(message: ChatMessage): Carrier | undefined {
  if (message.role !== "user") return undefined;
  const prefix = message.content.startsWith(PAYLOAD_PREFIX) ? PAYLOAD_PREFIX : "";
  const record = parseRecord(message.content.slice(prefix.length));
  if (!record || (prefix ? !record.worker : !CARRIER_KINDS.has(String(record.kind)))) return undefined;
  if (!Array.isArray(record.dependencyResults)) return undefined;
  return { prefix, record, dependencies: record.dependencyResults.filter((entry): entry is JsonRecord => asRecord(entry) !== undefined) };
}

function parseRecord(content: string): JsonRecord | undefined {
  try { return asRecord(JSON.parse(content)); } catch { return undefined; }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
