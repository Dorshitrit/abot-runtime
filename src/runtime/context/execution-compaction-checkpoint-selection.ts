import { MODEL_STEPS, type ModelStep } from "../../shared/model-steps.js";
import {
  executionCompactionScopeId,
  projectExecutionCompactionObjective,
} from "./execution-compaction-objective.js";
import {
  assertValidSemanticCompactionCheckpoint,
  createSemanticCompactionSha256Fingerprint as fingerprint,
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  type SemanticCompactionCheckpoint,
} from "./semantic-compaction/contracts.js";
import type { RequestContextCompactionStore } from "./semantic-compaction/store.js";

type ExecutionCheckpointSelection = Readonly<{
  requestId: string;
  prompt: string;
  objective: string;
  callId: string;
  store?: RequestContextCompactionStore;
  updates?: readonly Readonly<{ text: string }>[];
  scopeSuffix?: string;
  allowedConsumers?: readonly ModelStep[];
  sourceRevision?: number;
}>;

type AcceptedObjective = Readonly<{
  prefix: number;
  objectiveFingerprint: string;
}>;

/** Select immutable evidence; an earlier objective's continuation is not current intent. */
export function resolveExecutionEvidenceCheckpoint(
  params: ExecutionCheckpointSelection,
): SemanticCompactionCheckpoint | undefined {
  const store = params.store;
  if (!store) return undefined;
  const objectives = acceptedExecutionObjectives(params);
  const candidates = store
    .findByCallIds([params.callId])
    .filter((checkpoint) => {
      const accepted = objectives.get(checkpoint.scopeId);
      return (
        accepted !== undefined &&
        hasExecutionCheckpointBinding(checkpoint, accepted, params)
      );
    });
  candidates.sort(
    (left, right) =>
      objectives.get(right.scopeId)!.prefix -
        objectives.get(left.scopeId)!.prefix ||
      right.sourceRevision - left.sourceRevision ||
      right.sourceDigests.length - left.sourceDigests.length ||
      left.scopeId.localeCompare(right.scopeId),
  );
  for (const checkpoint of candidates) {
    const inherited =
      params.updates !== undefined &&
      checkpoint.objectiveFingerprint !== fingerprint(params.objective);
    if (hasMaterializedExecutionSources(checkpoint, store, inherited))
      return checkpoint;
  }
  return undefined;
}

function acceptedExecutionObjectives(
  params: ExecutionCheckpointSelection,
): ReadonlyMap<string, AcceptedObjective> {
  const objectives = new Map<string, AcceptedObjective>();
  if (params.updates === undefined) {
    objectives.set(executionCompactionScopeId(params), {
      prefix: 0,
      objectiveFingerprint: fingerprint(params.objective),
    });
    return objectives;
  }
  if (
    projectExecutionCompactionObjective(params.prompt, params.updates) !==
    params.objective
  )
    return objectives;
  for (let prefix = 0; prefix <= params.updates.length; prefix += 1) {
    const objective = projectExecutionCompactionObjective(
      params.prompt,
      params.updates.slice(0, prefix),
    );
    objectives.set(executionCompactionScopeId({ ...params, objective }), {
      prefix,
      objectiveFingerprint: fingerprint(objective),
    });
  }
  return objectives;
}

function hasExecutionCheckpointBinding(
  checkpoint: SemanticCompactionCheckpoint,
  accepted: AcceptedObjective,
  params: ExecutionCheckpointSelection,
): boolean {
  if (!isValidExecutionCheckpoint(checkpoint)) return false;
  if (checkpoint.requestId !== params.requestId) return false;
  if (checkpoint.callId !== params.callId) return false;
  if (checkpoint.roleId !== "supervisor") return false;
  if (checkpoint.contextLane !== SEMANTIC_COMPACTION_CONTEXT_LANE) return false;
  if (checkpoint.currentRequestFingerprint !== fingerprint(params.prompt))
    return false;
  if (checkpoint.objectiveFingerprint !== accepted.objectiveFingerprint)
    return false;
  if (
    params.sourceRevision !== undefined &&
    checkpoint.sourceRevision > params.sourceRevision
  )
    return false;
  return hasExecutionConsumers(
    checkpoint.allowedConsumers,
    params.allowedConsumers,
  );
}

function isValidExecutionCheckpoint(
  checkpoint: SemanticCompactionCheckpoint,
): boolean {
  try {
    assertValidSemanticCompactionCheckpoint(checkpoint);
    return true;
  } catch {
    return false;
  }
}

function hasExecutionConsumers(
  actual: readonly ModelStep[],
  expected: readonly ModelStep[] | undefined,
): boolean {
  if (
    actual.some(
      (consumer) =>
        consumer !== MODEL_STEPS.EXECUTION_DECISION &&
        consumer !== MODEL_STEPS.EXECUTION_RESPONSE,
    )
  )
    return false;
  if (!expected) return actual.includes(MODEL_STEPS.EXECUTION_DECISION);
  return (
    actual.length === expected.length &&
    actual.every((consumer, index) => consumer === expected[index])
  );
}

function hasMaterializedExecutionSources(
  checkpoint: SemanticCompactionCheckpoint,
  store: RequestContextCompactionStore,
  inherited: boolean,
): boolean {
  return checkpoint.sourceDigests.every((digest) => {
    const source = store.materializeSource(
      digest.sourceRef,
      digest.sourceFingerprint,
    );
    if (!source) {
      if (inherited)
        throw new Error("context_compaction_inheritance_source_missing");
      return false;
    }
    const exact =
      source.sourceRef === digest.sourceRef &&
      source.sourceFingerprint === digest.sourceFingerprint &&
      fingerprint(source.content) === digest.sourceFingerprint;
    if (!exact && inherited)
      throw new Error("context_compaction_inheritance_source_identity_invalid");
    return exact;
  });
}
