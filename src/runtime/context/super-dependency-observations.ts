import type { ChatMessage } from "../../model-gateway/types.js";
import { hasSuperContextContract } from "./super-context-policy.js";
import type { ExecutionPolicyAuthoritySnapshot, RoleCallFrame, RoleCallLedgerHead } from "../orchestration/role-calls/contracts.js";
import type { RoleCallDependencyResult } from "../orchestration/role-calls/dependency-results.js";
import type { SemanticCompactionCheckpoint } from "./semantic-compaction/contracts.js";
import { createCapabilityResultCompactionSource, projectSingleCopyCapabilityResult } from "./capability-result-compaction-source.js";
import { projectSelectedDependencyObservations } from "./super-dependency-observation-lineage.js";
import type { RequestToolResult } from "./request-tool-results.js";
export { projectSelectedDependencyObservations } from "./super-dependency-observation-lineage.js";

export type DependencyObservations = Readonly<{ observations?: readonly RequestToolResult[] }>;
type DependencyProjection = RoleCallDependencyResult & Readonly<{ semanticCheckpoints?: readonly SemanticCompactionCheckpoint[] }>;

/** Enriches only the canonical selected SUPER dependency lane; storage stays in the ledger. */
export function projectSuperDependencyObservations<T extends DependencyProjection>(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  dependencies: readonly T[],
): readonly (T & DependencyObservations)[] {
  const eligible = projectSelectedDependencyObservations(head, call);
  if (eligible.length === 0) return dependencies;
  const sources = new Map(eligible.map((result) => [result.executionId, createCapabilityResultCompactionSource(result)]));
  const represented = new Set<string>();
  for (const dependency of dependencies) {
    for (const checkpoint of dependency.semanticCheckpoints ?? []) {
      for (const digest of checkpoint.sourceDigests) {
        if (sources.get(digest.sourceRef)?.sourceFingerprint === digest.sourceFingerprint) represented.add(digest.sourceRef);
      }
    }
  }
  let changed = false;
  const projected = dependencies.map((dependency) => {
    const observations = projectSelectedDependencyObservations(head, call, dependency.resultRef)
      .filter((result) => !represented.has(result.executionId));
    if (observations.length === 0) return dependency;
    changed = true;
    for (const result of observations) represented.add(result.executionId);
    return Object.freeze({ ...dependency, observations: Object.freeze(observations.map(projectSingleCopyCapabilityResult)) });
  });
  return changed ? Object.freeze(projected) : dependencies;
}

/** Supplied payload data must match the selected canonical execution bytes exactly. */
export function assertBoundDependencyObservations(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  dependencies: readonly (RoleCallDependencyResult & DependencyObservations)[],
): void {
  for (const dependency of dependencies) {
    const observations = (dependency as RoleCallDependencyResult & DependencyObservations).observations;
    if (observations === undefined) continue;
    const canonical = new Map(projectSelectedDependencyObservations(head, call, dependency.resultRef)
      .map((result) => [result.executionId, createCapabilityResultCompactionSource(result)]));
    if (!Array.isArray(observations) || observations.length === 0) throw new Error("worker_dependency_observations_invalid");
    const seen = new Set<string>();
    for (const observation of observations) {
      const source = createCapabilityResultCompactionSource(observation);
      if (seen.has(source.sourceRef) || canonical.get(source.sourceRef)?.content !== source.content || JSON.stringify(observation) !== source.content)
        throw new Error("worker_dependency_observations_invalid");
      seen.add(source.sourceRef);
    }
  }
}

/** target_only keeps its existing selected-target boundary, even with sibling observations. */
export function projectPayloadDependencyObservationScope<T extends { contextScope?: string; dependencyResults?: readonly unknown[] }>(
  context: T,
  authority?: ExecutionPolicyAuthoritySnapshot,
): T {
  if (!authority || !hasSuperContextContract(authority, "delegated.worker")) return context;
  if (context.contextScope !== "target_only" || !context.dependencyResults) return context;
  let changed = false;
  const dependencyResults = context.dependencyResults.map((dependency) => {
    if (!dependency || typeof dependency !== "object" || !("observations" in dependency)) return dependency;
    const { observations: _observations, ...metadata } = dependency;
    changed = true;
    return Object.freeze(metadata);
  });
  return changed ? { ...context, dependencyResults: Object.freeze(dependencyResults) } : context;
}

export function isDependencyObservationList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((result) => {
    if (!result || typeof result !== "object" || result.observedEffect !== "observation") return false;
    try { return createCapabilityResultCompactionSource(result).content === JSON.stringify(result); } catch { return false; }
  });
}

/** Controls reuse identical dependency rows from their accepted Worker assignment. */
export function projectUnsharedSuperDependencyResults(
  dependencies: readonly (DependencyProjection & DependencyObservations)[],
  sharedMessages: readonly ChatMessage[],
  authority: ExecutionPolicyAuthoritySnapshot | undefined,
  binding: Readonly<{ callId: string; invocationAttempt: number }>,
): readonly (DependencyProjection & DependencyObservations)[] {
  if (!authority || !hasSuperContextContract(authority, "delegated.worker")) return dependencies;
  if (dependencies.length === 0) return dependencies;
  const sharedBodies = new Set<string>();
  const shared = new Map<string, Set<string>>();
  for (const message of sharedMessages) {
    if (message.role !== "user") continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(message.content) as Record<string, unknown>; } catch { continue; }
    const matchesWorkerAssignment = record?.kind === "runtime_worker_assignment" &&
      record.callId === binding.callId && record.invocationAttempt === binding.invocationAttempt;
    if (!matchesWorkerAssignment || !Array.isArray(record.dependencyResults)) continue;
    for (const dependency of record.dependencyResults as (DependencyProjection & DependencyObservations)[]) {
      sharedBodies.add(JSON.stringify(dependency));
      const key = JSON.stringify([dependency.resultRef, dependency.producerCallId]);
      const represented = shared.get(key) ?? new Set<string>();
      for (const observation of dependency.observations ?? []) represented.add(JSON.stringify(observation));
      shared.set(key, represented);
    }
  }
  let changed = false;
  const projected = dependencies.flatMap((dependency) => {
    if (sharedBodies.has(JSON.stringify(dependency))) { changed = true; return []; }
    if (!dependency.observations) return [dependency];
    const represented = shared.get(JSON.stringify([dependency.resultRef, dependency.producerCallId]));
    const remaining = dependency.observations.filter((observation) => !represented?.has(JSON.stringify(observation)));
    if (remaining.length === dependency.observations.length) return [dependency];
    changed = true;
    const { observations: _observations, ...metadata } = dependency;
    return [Object.freeze({ ...metadata, ...(remaining.length ? { observations: Object.freeze(remaining) } : {}) })];
  });
  return changed ? Object.freeze(projected) : dependencies;
}
