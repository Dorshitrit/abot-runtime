import { executionCompactionScopeId } from "./execution-compaction-objective.js";
import { isDeepStrictEqual } from "node:util";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionDigest,
} from "./semantic-compaction/contracts.js";
import type { RequestContextCompactionStore } from "./semantic-compaction/store.js";

type ExecutionEvidenceIdentity = Readonly<{
  executionId: string;
  callId: string;
  invocationAttempt: number;
  capabilityId: string;
  adapterResult: unknown;
}>;

export type ExecutionCompactedSource = SemanticCompactionDigest &
  Readonly<{ executionId: string }>;

export type ExecutionCompactedSources = Readonly<{
  scopeId: string;
  sourceRevision: number;
  sources: readonly ExecutionCompactedSource[];
}>;

type ExecutionEvidenceProjection = Readonly<{
  requestId: string;
  prompt: string;
  objective: string;
  callId: string;
  store?: RequestContextCompactionStore;
  results: readonly ExecutionEvidenceIdentity[];
}>;

/** Resolve only source digests; never transfer the root's continuation authority. */
export function resolveExecutionCompactedSources(
  params: ExecutionEvidenceProjection,
): ExecutionCompactedSources | undefined {
  const store = params.store;
  if (!store) return undefined;
  const checkpoint = store
    .findByCallIds([params.callId])
    .find((candidate) => canReuseExecutionCheckpoint(candidate, params));
  if (!checkpoint) return undefined;
  const digests = new Map(
    checkpoint.sourceDigests.map((digest) => [digest.sourceRef, digest]),
  );
  const sources: ExecutionCompactedSource[] = [];
  for (const result of params.results) {
    const digest = digests.get(`tool-result:${result.executionId}`);
    if (!digest) continue;
    if (result.callId !== checkpoint.callId) continue;
    const source = store.materializeSource(
      digest.sourceRef,
      digest.sourceFingerprint,
    );
    if (!source || !matchesCompactedExecutionResult(source.content, result))
      continue;
    sources.push(Object.freeze({ ...digest, executionId: result.executionId }));
  }
  if (sources.length === 0) return undefined;
  return Object.freeze({
    scopeId: checkpoint.scopeId,
    sourceRevision: checkpoint.sourceRevision,
    sources: Object.freeze(sources),
  });
}

function canReuseExecutionCheckpoint(
  checkpoint: SemanticCompactionCheckpoint,
  params: ExecutionEvidenceProjection,
): boolean {
  if (checkpoint.requestId !== params.requestId) return false;
  if (checkpoint.callId !== params.callId) return false;
  if (checkpoint.roleId !== "supervisor") return false;
  if (checkpoint.scopeId !== executionCompactionScopeId(params)) return false;
  if (
    checkpoint.currentRequestFingerprint !==
    createSemanticCompactionSha256Fingerprint(params.prompt)
  )
    return false;
  if (
    checkpoint.objectiveFingerprint !==
    createSemanticCompactionSha256Fingerprint(params.objective)
  )
    return false;
  return checkpoint.allowedConsumers.includes(MODEL_STEPS.EXECUTION_DECISION);
}

export function matchesCompactedExecutionResult(
  content: string,
  result: ExecutionEvidenceIdentity,
): boolean {
  const message = readCompactionRecord(content);
  if (message?.role !== "tool") return false;
  if (message.toolCallId !== result.executionId) return false;
  if (message.attachments !== undefined) return false;
  const envelope = readCompactionRecord(message.content);
  if (envelope?.kind !== "runtime_execution_capability_result_v1") return false;
  if (envelope.invocationAttempt !== result.invocationAttempt) return false;
  const covered = compactionRecord(envelope.result);
  if (covered?.executionId !== result.executionId) return false;
  if (covered.capabilityId !== result.capabilityId) return false;
  return isDeepStrictEqual(covered.adapterResult, result.adapterResult);
}

function readCompactionRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return compactionRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function compactionRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}
