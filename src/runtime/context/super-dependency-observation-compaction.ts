import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestToolResult } from "./request-tool-results.js";
import type { SemanticCompactionCheckpoint, SemanticCompactionSource } from "./semantic-compaction/contracts.js";
import type { SuperWorkerCompactionSidecar } from "./super-worker-compaction-sidecar.js";
import { createCapabilityResultCompactionSource } from "./capability-result-compaction-source.js";
import { CompactionSourceInvariantError } from "./compaction-source-invariant.js";
import { hasSuperContextContract } from "./super-context-policy.js";
import { projectCheckpointMessages, scanCompactionSources } from "./model-step-compaction-projection.js";

type CompactionProjection = Readonly<{
  scanCompactionSources: typeof scanCompactionSources;
  projectCheckpointMessages: typeof projectCheckpointMessages;
}>;
const MAIN_COMPACTION_PROJECTION: CompactionProjection = Object.freeze({
  scanCompactionSources, projectCheckpointMessages,
});

/** Only an existing canonical SUPER binding selects the dependency extension. */
export function resolveSuperDependencyObservationCompaction(
  sidecar?: SuperWorkerCompactionSidecar,
): CompactionProjection {
  if (!sidecar) return MAIN_COMPACTION_PROJECTION;
  if (!hasSuperContextContract(sidecar.head.policy.authority, "delegated.worker"))
    return MAIN_COMPACTION_PROJECTION;
  return Object.freeze({
    scanCompactionSources: (messages, scopeId, overrides) =>
      scanSuperDependencyCompactionSources(messages, scopeId, overrides, sidecar),
    projectCheckpointMessages: (...args) => projectSuperDependencyCheckpointMessages(...args),
  });
}

function scanSuperDependencyCompactionSources(
  messages: readonly ChatMessage[],
  scopeId: string,
  overrides: ReadonlyMap<string, SemanticCompactionSource>,
  sidecar: SuperWorkerCompactionSidecar,
): ReturnType<typeof scanCompactionSources> {
  const sources = new Map<string, ReturnType<typeof scanCompactionSources>[number]>();
  for (const [index, message] of messages.entries()) {
    for (const source of [
      ...scanCompactionSources([message], scopeId, overrides, sidecar).map(({ source }) => source),
      ...scanDependencyObservationSources(message, overrides, sidecar),
    ]) {
      const previous = sources.get(source.sourceRef);
      if (hasSourceConflict(previous?.source, source))
        throw new CompactionSourceInvariantError("context_compaction_source_identity_conflict", source.sourceRef);
      if (previous) continue;
      sources.set(source.sourceRef, Object.freeze({ index, source }));
    }
  }
  return Object.freeze([...sources.values()]);
}

function hasSourceConflict(
  previous: SemanticCompactionSource | undefined,
  candidate: SemanticCompactionSource,
): boolean {
  return previous !== undefined && (
    previous.sourceFingerprint !== candidate.sourceFingerprint || previous.content !== candidate.content
  );
}

/** MAIN owns ordinary sources; SUPER removes only its covered nested observations. */
function projectSuperDependencyCheckpointMessages(
  ...[messages, scopeId, checkpoint, overrides, superOwned, recordVerifiedProjection, options]: Parameters<typeof projectCheckpointMessages>
): ChatMessage[] {
  const verified: ChatMessage[] = [];
  const projected = projectCheckpointMessages(
    messages, scopeId, checkpoint, overrides, superOwned,
    recordVerifiedProjection ? (message) => verified.push(message) : undefined,
    options,
  );
  const replacements = new Map<ChatMessage, ChatMessage>();
  let firstCoveredAssignment: ChatMessage | undefined;
  const result = projected.map((message) => {
    const replacement = projectDependencyObservationCheckpointMessage(message, checkpoint, overrides);
    if (!replacement) return message;
    replacements.set(message, replacement);
    firstCoveredAssignment ??= replacement;
    return replacement;
  });
  // An ordinary assignment has no MAIN sources, so its standalone summary may be
  // appended. Keep that same checkpoint object before the first covered assignment.
  placeDependencyCheckpointBeforeAssignment(result, firstCoveredAssignment, scopeId);
  for (const message of verified)
    recordVerifiedProjection?.(replacements.get(message) ?? message);
  return result;
}

function placeDependencyCheckpointBeforeAssignment(
  messages: ChatMessage[],
  assignment: ChatMessage | undefined,
  scopeId: string,
): void {
  if (!assignment) return;
  const anchor = messages.indexOf(assignment);
  const checkpointIndex = messages.findIndex((message) => isStandaloneDependencyCheckpoint(message, scopeId));
  if (checkpointIndex <= anchor) return;
  const [checkpoint] = messages.splice(checkpointIndex, 1);
  messages.splice(anchor, 0, checkpoint!);
}

function isStandaloneDependencyCheckpoint(message: ChatMessage, scopeId: string): boolean {
  let record: Record<string, unknown>;
  try { record = JSON.parse(message.content) as Record<string, unknown>; } catch { return false; }
  if (record?.kind !== "runtime_semantic_compaction_checkpoint_v2") return false;
  return record.scopeId === scopeId;
}

const PAYLOAD_PREFIX = "Canonical runtime context:\n";
const WORKER_DEPENDENCY_KINDS = new Set([
  "runtime_worker_assignment", "runtime_worker_capability_execution_assignment", "runtime_worker_result_assignment",
]);
type Carrier = Readonly<{ prefix: string; record: Record<string, unknown>; dependencies: readonly Record<string, unknown>[] }>;

/** Only known runtime assignment carriers can contribute nested dependency observations. */
export function hasDependencyObservationCarrier(message: ChatMessage): boolean {
  return readCarrier(message) !== undefined;
}

export function scanDependencyObservationSources(
  message: ChatMessage,
  overrides: ReadonlyMap<string, SemanticCompactionSource>,
  sidecar?: SuperWorkerCompactionSidecar,
): readonly SemanticCompactionSource[] {
  const carrier = readCarrier(message);
  if (!carrier) return [];
  const sources = new Map<string, SemanticCompactionSource>();
  for (const dependency of carrier.dependencies) {
    for (const observation of readObservations(dependency)) {
      const source = requireCanonicalObservationSource(observation, overrides);
      if (sidecar && !sidecar.eligibleExecutionIds.includes(source.sourceRef))
        throw new CompactionSourceInvariantError("context_compaction_dependency_source_unselected", source.sourceRef);
      sources.set(source.sourceRef, source);
    }
  }
  return Object.freeze([...sources.values()]);
}

/** The regular checkpoint message remains the one summary; assignments retain their identity. */
export function projectDependencyObservationCheckpointMessage(
  message: ChatMessage,
  checkpoint: SemanticCompactionCheckpoint,
  overrides: ReadonlyMap<string, SemanticCompactionSource>,
): ChatMessage | undefined {
  if (message.role !== "user") return undefined;
  const carrier = readCarrier(message);
  if (!carrier) return undefined;
  const covered = new Map(checkpoint.sourceDigests.map((source) => [source.sourceRef, source.sourceFingerprint]));
  let changed = false;
  const dependencyResults = carrier.dependencies.map((dependency) => {
    const observations = readObservations(dependency);
    const remaining = observations.filter((observation) => {
      const source = requireCanonicalObservationSource(observation, overrides);
      return covered.get(source.sourceRef) !== source.sourceFingerprint;
    });
    if (remaining.length === observations.length) return dependency;
    changed = true;
    const { observations: _observations, ...metadata } = dependency;
    return { ...metadata, ...(remaining.length > 0 ? { observations: remaining } : {}) };
  });
  if (!changed) return undefined;
  return Object.freeze({ ...message, content: carrier.prefix + JSON.stringify({ ...carrier.record, dependencyResults }) });
}

function requireCanonicalObservationSource(
  observation: RequestToolResult,
  overrides: ReadonlyMap<string, SemanticCompactionSource>,
): SemanticCompactionSource {
  const source = createCapabilityResultCompactionSource(observation);
  const canonical = overrides.get(source.sourceRef);
  if (!canonical || canonical.content !== source.content || canonical.sourceFingerprint !== source.sourceFingerprint || JSON.stringify(observation) !== source.content)
    throw new CompactionSourceInvariantError("context_compaction_dependency_source_changed", source.sourceRef);
  return canonical;
}

function readObservations(dependency: Record<string, unknown>): readonly RequestToolResult[] {
  if (dependency.observations === undefined) return [];
  if (!Array.isArray(dependency.observations) || dependency.observations.length === 0)
    throw new Error("context_compaction_dependency_observations_invalid");
  return dependency.observations as readonly RequestToolResult[];
}

function readCarrier(message: ChatMessage): Carrier | undefined {
  if (message.role !== "user") return undefined;
  const prefix = message.content.startsWith(PAYLOAD_PREFIX) ? PAYLOAD_PREFIX : "";
  let value: unknown;
  try { value = JSON.parse(message.content.slice(prefix.length)); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (prefix ? !record.worker : !WORKER_DEPENDENCY_KINDS.has(String(record.kind))) return undefined;
  if (!Array.isArray(record.dependencyResults)) return undefined;
  const dependencies = record.dependencyResults as Record<string, unknown>[];
  if (!dependencies.some((dependency) => dependency && Object.hasOwn(dependency, "observations"))) return undefined;
  return { prefix, record, dependencies };
}
