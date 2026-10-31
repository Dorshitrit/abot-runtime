import { projectSuperDependencyObservations, type DependencyObservations } from "../super-dependency-observations.js";
import { hasSuperContextContract } from "../super-context-policy.js";
import { assertSuperCompactionCheckpointIntegrity } from "./super-source-integrity.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import {
  projectRoleCallDependencyResults,
  type RoleCallDependencyResult,
  type RoleCallFrame,
  type RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  assertValidSemanticCompactionCheckpoint,
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionCheckpoint,
} from "./contracts.js";
import type { RequestContextCompactionStore } from "./store.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "./evidence-scope.js";

export type SemanticCompactionDependencyResult = Readonly<
  RoleCallDependencyResult & DependencyObservations &
    Readonly<{
      semanticCheckpoints?: readonly SemanticCompactionCheckpoint[];
    }>
>;

/**
 * Carries request-local semantic checkpoints only through canonical result
 * dependencies. The ledger remains the authority for applicability; the
 * compaction store supplies only the already committed continuation data.
 */
export function projectSemanticCompactionDependencyResults(params: {
  requestId: string;
  prompt: string;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  consumer: ModelStep;
  store?: RequestContextCompactionStore;
}): readonly SemanticCompactionDependencyResult[] {
  const dependencyResults = projectRoleCallDependencyResults(
    params.head,
    params.call,
  );
  if (!params.store || dependencyResults.length === 0) {
    return projectSuperDependencyObservations(params.head, params.call, dependencyResults);
  }

  const callsById = new Map(
    params.head.state.calls.map((call) => [call.callId, call] as const),
  );
  const resultsByRef = new Map(
    params.head.state.results.map(
      (result) => [result.resultRef, result] as const,
    ),
  );
  const currentRequestFingerprint = createSemanticCompactionSha256Fingerprint(
    params.prompt,
  );

  const usesSuperCheckpointProjection = hasSuperContextContract(
    params.head.policy.authority, "supervisor",
  );
  const representedCheckpointScopes = new Set<string>();
  const retainFirstCheckpoint = (checkpoint: SemanticCompactionCheckpoint): boolean => {
    if (!usesSuperCheckpointProjection) return true;
    if (representedCheckpointScopes.has(checkpoint.scopeId)) return false;
    representedCheckpointScopes.add(checkpoint.scopeId);
    return true;
  };

  const checkpointResults = Object.freeze(
    dependencyResults.map((result) => {
      const lineageCallIds = collectResultLineageCallIds({
        producerCallId: result.producerCallId,
        callsById,
        resultsByRef,
      });
      const checkpoints = params
        .store!.findByCallIds(lineageCallIds)
        .filter((checkpoint) => {
          assertValidSemanticCompactionCheckpoint(checkpoint);
          if (usesSuperCheckpointProjection) {
            assertSuperCompactionCheckpointIntegrity({
              ...params,
              store: params.store!,
              checkpoint,
            });
          }
          const checkpointCall = callsById.get(checkpoint.callId);
          if (
            !checkpointCall?.objective ||
            checkpoint.requestId !== params.requestId ||
            checkpoint.currentRequestFingerprint !==
              currentRequestFingerprint ||
            checkpoint.roleId !== checkpointCall.roleId ||
            checkpoint.objectiveFingerprint !==
              createSemanticCompactionSha256Fingerprint(
                checkpointCall.objective,
              ) ||
            checkpoint.contextLane !== SEMANTIC_COMPACTION_CONTEXT_LANE
          ) {
            throw new Error(
              "context_compaction_dependency_checkpoint_not_applicable",
            );
          }
          return checkpoint.allowedConsumers.includes(params.consumer);
        })
        // Validate every occurrence before omitting already represented continuity.
        .filter(retainFirstCheckpoint)
        .map((checkpoint) =>
          Object.freeze({
            ...checkpoint,
            evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
          }),
        );
      return checkpoints.length === 0
        ? result
        : Object.freeze({
            ...result,
            semanticCheckpoints: Object.freeze(checkpoints),
          });
    }),
  );
  return projectSuperDependencyObservations(params.head, params.call, checkpointResults);
}

function collectResultLineageCallIds(params: {
  producerCallId: string;
  callsById: ReadonlyMap<string, RoleCallFrame>;
  resultsByRef: ReadonlyMap<
    string,
    Readonly<{ resultRef: string; producerCallId: string }>
  >;
}): readonly string[] {
  const visited = new Set<string>();
  const ordered: string[] = [];

  const visit = (callId: string): void => {
    if (visited.has(callId)) return;
    const call = params.callsById.get(callId);
    if (!call) {
      throw new Error("context_compaction_dependency_lineage_invalid");
    }
    visited.add(callId);
    for (const dependencyResultRef of call.dependencyResultRefs) {
      const dependency = params.resultsByRef.get(dependencyResultRef);
      if (!dependency) {
        throw new Error("context_compaction_dependency_lineage_invalid");
      }
      visit(dependency.producerCallId);
    }
    for (const childCallId of call.childCallIds) {
      const child = params.callsById.get(childCallId);
      if (
        !child ||
        child.parentCallId !== call.callId ||
        child.status !== "completed" ||
        !child.resultRef ||
        params.resultsByRef.get(child.resultRef)?.producerCallId !==
          child.callId
      ) {
        throw new Error("context_compaction_dependency_lineage_invalid");
      }
      visit(childCallId);
    }
    ordered.push(callId);
  };

  visit(params.producerCallId);
  return Object.freeze(ordered);
}
