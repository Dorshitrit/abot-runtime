import type { CheckpointContinuationProjector } from "./semantic-compaction/continuation-projection.js";
import { readInheritedCompactionCheckpoint } from "./model-step-compaction-inheritance.js";
import { projectCheckpointMessages, scanCompactionSources, createResultSourceOverrideMap } from "./model-step-compaction-projection.js";
import { createVerifiedCompactionProjection } from "./verified-compaction-projection.js";
import { readOperationSupervisionEvidenceBinding } from "./operation-supervision-evidence-binding.js";
import { projectOperationSupervisionEvidenceClosure } from "./operation-supervision-evidence-projection.js";
import { superWorkerCompactionFailureOwner } from "./super-worker-compaction-failure.js";
import {
  withSuperCompactionFailure,
  type SuperCompactionFailureOwner,
} from "./super-compaction-failure-owner.js";
import { resolveSuperWorkerCompactionProjection } from "./super-worker-compaction-projection.js";
import type { SuperWorkerCompactionSidecar } from "./super-worker-compaction-sidecar.js";
import { CompactionSourceInvariantError } from "./compaction-source-invariant.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import type {
  ModelStepContextCompactionController,
  ModelStepCompactionStage,
} from "../model/model-step-port.js";
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
  call: Readonly<{
    roleId: string;
    callId: string;
    objective: string | null;
    activationCount?: number;
  }>;
  sourceRevision: number;
  allowedConsumers: readonly ModelStep[];
  scopeId?: string;
  scopeSuffix?: string;
  resultSourceOverrides?: readonly SemanticCompactionSource[];
  inheritedCheckpoint?: SemanticCompactionCheckpoint;
  superWorkerCompaction?: SuperWorkerCompactionSidecar;
  requireSuperWorkerSources?: boolean;
  consumer?: ModelStep;
  superFailureOwner?: SuperCompactionFailureOwner;
  projectContinuation?: CheckpointContinuationProjector;
  supportsProjectionRepair?: true;
  hasVerifiedCompactedEvidence?(messages: readonly ChatMessage[]): boolean;
}>;

export function createModelStepCompactionController(
  request: SemanticCompactionRequest,
  options: ModelStepCompactionOptions,
  generateCandidate = generateSemanticCompactionCandidateBatched,
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
  const inherited = readInheritedCompactionCheckpoint({
    checkpoint: options.inheritedCheckpoint,
    store,
    binding,
    scopeId,
    sourceRevision: options.sourceRevision,
  });
  const verifiedProjection = createVerifiedCompactionProjection();
  let projectedCheckpoint: SemanticCompactionCheckpoint | undefined;
  const reconcileEvidence = (
    messages: readonly ChatMessage[],
    checkpoint?: SemanticCompactionCheckpoint,
  ) =>
    projectOperationSupervisionEvidenceClosure(
      messages,
      {
        requestId: request.requestId,
        call: options.call,
        sourceRevision: options.sourceRevision,
        consumer: options.consumer,
      },
      checkpoint ? { checkpoint, store } : undefined,
    );
  const sourceProjection = (messages: readonly ChatMessage[]) => {
    const sidecar = resolveSuperWorkerCompactionProjection(
      messages,
      {
        requestId: request.requestId,
        callId: options.call.callId,
        sourceRevision: options.sourceRevision,
      },
      options.superWorkerCompaction,
      options.requireSuperWorkerSources,
    );
    const failureOwner =
      superWorkerCompactionFailureOwner(
        sidecar,
        options.consumer,
        "model_context_projection",
        scopeId,
      ) ?? options.superFailureOwner;
    withSuperCompactionFailure(failureOwner, () => reconcileEvidence(messages));
    return {
      sidecar,
      failureOwner,
      overrides: createResultSourceOverrideMap(
        sidecar?.sources ?? options.resultSourceOverrides ?? [],
      ),
    };
  };

  const readPrevious = (
    messages: readonly ChatMessage[],
  ): SemanticCompactionCheckpoint | undefined => {
    const previous = store.get(scopeId);
    if (!previous) return undefined;
    assertValidSemanticCompactionCheckpoint(previous);
    if (
      (options.requireSuperWorkerSources ||
        options.superFailureOwner ||
        messages.some(readOperationSupervisionEvidenceBinding)) &&
      previous.sourceRevision > options.sourceRevision
    ) {
      throw new Error("context_compaction_checkpoint_revision_invalid");
    }
    if (!sameSemanticCompactionCheckpointBinding(previous, binding)) {
      throw new Error("context_compaction_checkpoint_not_applicable");
    }
    return previous;
  };

  const activeStage = Object.freeze<ModelStepCompactionStage>({
    compactionScope: "active_request",
    scopeId,
    ...(options.supportsProjectionRepair ? { supportsProjectionRepair: true } : {}),
    async prepare(messages, context) {
      const {
        sidecar,
        failureOwner,
        overrides: resultSourceOverrides,
      } = sourceProjection(messages);
      const previous = withSuperCompactionFailure(failureOwner, () =>
        readPrevious(messages),
      );
      const evidence = previous ?? inherited;
      const scanned = scanCompactionSources(
        messages,
        scopeId,
        resultSourceOverrides,
        sidecar,
      );
      const covered = new Map(
        evidence?.sourceDigests.map((source) => [source.sourceRef, source]) ??
          [],
      );
      const newSources = withSuperCompactionFailure(failureOwner, () =>
        scanned
          .map(({ source }) => source)
          .filter((source) => {
            const existing = covered.get(source.sourceRef);
            if (!existing) return true;
            if (existing.sourceFingerprint !== source.sourceFingerprint) {
              if (failureOwner) {
                throw new CompactionSourceInvariantError(
                  "context_compaction_source_identity_conflict",
                  source.sourceRef,
                );
              }
              throw new Error("context_compaction_source_identity_conflict");
            }
            return false;
          }),
      );
      const hasNewCompactionSources = newSources.length > 0;
      if (!hasNewCompactionSources) {
        return Object.freeze({
          kind: "unavailable",
          reason: evidence ? "no_new_sources" : "no_eligible_sources",
        });
      }
      const candidate = await generateCandidate({
        request,
        scopeId,
        binding,
        sourceRevision: options.sourceRevision,
        preservationObjective: options.call.objective!,
        boundSteeringVersion: context?.boundSteeringVersion,
        projectionRepair: context?.projectionRepair,
        consumer: options.consumer,
        ...(previous ? { previous } : {}),
        ...(!previous && inherited
          ? { inheritedSourceDigests: inherited.sourceDigests }
          : {}),
        sources: newSources,
        ...(sidecar || failureOwner
          ? { registrationMode: "atomic" as const }
          : {}),
        ...(failureOwner ? { failureOwner } : {}),
      });
      const preparedMessages = withSuperCompactionFailure(failureOwner, () =>
        reconcileEvidence(
          projectCheckpointMessages(
            messages,
            scopeId,
            candidate,
            resultSourceOverrides,
            failureOwner !== undefined,
            undefined,
            { replacesScopeId: inherited?.scopeId, projectContinuation: options.projectContinuation },
          ),
          candidate,
        ),
      );
      return Object.freeze({
        kind: "prepared",
        preparation: Object.freeze({
          messages: preparedMessages,
          hasExhaustedCompactionSources:
            scanCompactionSources(
              preparedMessages,
              scopeId,
              resultSourceOverrides,
              sidecar,
            ).length === 0,
          commit() {
            withSuperCompactionFailure(failureOwner, () =>
              store.commit(candidate),
            );
          },
          scopeId,
          sourceRevision: candidate.sourceRevision,
          coveredSourceCount: candidate.sourceDigests.length,
        }),
      });
    },
  });

  return Object.freeze({
    project(messages) {
      verifiedProjection.clear();
      const { failureOwner, overrides: resultSourceOverrides } =
        sourceProjection(messages);
      const previous = withSuperCompactionFailure(failureOwner, () =>
        readPrevious(messages),
      );
      const evidence = previous ?? inherited;
      projectedCheckpoint = evidence;
      return withSuperCompactionFailure(failureOwner, () =>
        reconcileEvidence(
          evidence
            ? projectCheckpointMessages(
                messages,
                scopeId,
                evidence,
                resultSourceOverrides,
                failureOwner !== undefined,
                verifiedProjection.record,
                {
                  includeContinuation: previous !== undefined,
                  projectContinuation: options.projectContinuation,
                  replacesScopeId: inherited?.scopeId,
                },
              )
            : [...messages],
          evidence,
        ),
      );
    },
    hasExhaustedVerifiedCompactionSources(messages) {
      const ownProjection =
        projectedCheckpoint !== undefined &&
        store.get(projectedCheckpoint.scopeId) === projectedCheckpoint &&
        verifiedProjection.contains(messages);
      if (!ownProjection && !options.hasVerifiedCompactedEvidence?.(messages))
        return false;
      const { sidecar, overrides } = sourceProjection(messages);
      return (
        scanCompactionSources(messages, scopeId, overrides, sidecar).length === 0
      );
    },
    getStages() {
      return Object.freeze([activeStage]);
    },
  });
}
