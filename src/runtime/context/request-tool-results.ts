import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import {
  isRoleCapabilityId,
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallLedgerHead,
  type RoleCapabilityDeclaredEffect,
  type RoleCapabilityExecutionOutcome,
  type RoleCapabilityObservedEffect,
  type RoleCapabilityResultReference,
} from "../orchestration/role-calls/index.js";
import { traceDebug } from "../observability/debug-logger.js";
import {
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResult,
  type CapabilityJsonObject,
  type CapabilityJsonValue,
} from "../orchestration/capability-adapters/result.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionCheckpoint,
} from "./semantic-compaction/index.js";
import {
  projectAcceptedCapabilityAction,
  type AcceptedCapabilityAction,
} from "./accepted-capability-action.js";

export const REQUEST_TOOL_RESULTS_MESSAGE_KIND =
  "runtime_request_tool_results_v1" as const;

const REQUEST_TOOL_RESULTS_LOG_SCOPE = "runtime.request_tool_results";

export type RequestToolResult = Readonly<{
  executionId: string;
  callId: string;
  invocationAttempt: number;
  capabilityId: string;
  declaredEffect: RoleCapabilityDeclaredEffect;
  outcome: RoleCapabilityExecutionOutcome;
  observedEffect: RoleCapabilityObservedEffect;
  summary: string;
  referenceData?: string;
  references?: readonly RoleCapabilityResultReference[];
  /** Exact accepted action, projected only to the call that produced it. */
  acceptedAction?: AcceptedCapabilityAction;
  /** Exact canonical evidence, projected only to the call that produced it. */
  adapterResult?: CapabilityAdapterResult;
  summaryProjection?: "superseded_target_evidence";
  supersededByExecutionIds?: readonly string[];
}>;

export type RequestToolResultsView = Readonly<{
  sourceRevision: number;
  results: readonly RequestToolResult[];
}>;

/**
 * Projects every settled capability result in canonical ledger order.
 * Summaries remain request-wide. Complete reference data is projected only
 * back to the exact call that produced it; callers consume the settled child
 * result instead of receiving a second copy of the capability payload.
 */
export function projectRequestToolResults(
  params: Readonly<{
    ledger: RoleCallLedger;
    head: RoleCallLedgerHead;
    modelStep: ModelStep;
    callId: string;
  }>,
): RequestToolResultsView {
  const projected: RequestToolResult[] = [];
  const sourceProjected: RequestToolResult[] = [];
  let runningExecutionCount = 0;

  try {
    if (params.ledger.current() !== params.head) {
      throw new Error("request_tool_results_head_stale");
    }
    if (
      !params.head.state.calls.some(({ callId }) => callId === params.callId)
    ) {
      throw new Error("request_tool_results_call_invalid");
    }

    for (const execution of params.head.state.capabilityExecutions) {
      if (execution.status === "running") {
        runningExecutionCount += 1;
        continue;
      }
      const exactResult = normalizeCapabilityAdapterResult(
        execution.exactResult,
      );
      if (
        execution.status !== "settled" ||
        typeof execution.executionId !== "string" ||
        execution.executionId.length === 0 ||
        typeof execution.callId !== "string" ||
        execution.callId.length === 0 ||
        !Number.isSafeInteger(execution.invocationAttempt) ||
        execution.invocationAttempt < 1 ||
        !isRoleCapabilityId(execution.capabilityId) ||
        !isDeclaredEffect(execution.declaredEffect) ||
        !isOutcome(execution.outcome) ||
        !isObservedEffect(execution.observedEffect) ||
        !isBoundedSummary(execution.summary) ||
        !isOptionalBoundedReferenceData(execution.referenceData) ||
        !isValidReferences(execution.references) ||
        !exactResult.ok
      ) {
        throw new Error("request_tool_results_execution_invalid");
      }
      const sourceResult = Object.freeze({
        executionId: execution.executionId,
        callId: execution.callId,
        invocationAttempt: execution.invocationAttempt,
        capabilityId: execution.capabilityId,
        declaredEffect: execution.declaredEffect,
        outcome: execution.outcome,
        observedEffect: execution.observedEffect,
        summary: execution.summary,
        ...(execution.referenceData
          ? { referenceData: execution.referenceData }
          : {}),
        ...(execution.references
          ? { references: Object.freeze([...execution.references]) }
          : {}),
        ...(execution.actionFingerprint
          ? {
              acceptedAction: projectAcceptedCapabilityAction(
                params.head,
                execution,
              ),
            }
          : {}),
        adapterResult: exactResult.value,
      });
      sourceProjected.push(sourceResult);
      if (execution.callId !== params.callId) {
        const {
          referenceData: _referenceData,
          adapterResult: _adapterResult,
          acceptedAction: _acceptedAction,
          ...summaryOnlyResult
        } = sourceResult;
        projected.push(Object.freeze(summaryOnlyResult));
      } else {
        projected.push(sourceResult);
      }
    }

    const currentResults = projectCurrentRequestToolResults(projected);
    const view = Object.freeze({
      sourceRevision: params.head.revision,
      results: Object.freeze(currentResults),
    });
    traceProjection(
      "projected",
      params,
      currentResults,
      runningExecutionCount,
      undefined,
      sourceProjected,
    );
    return view;
  } catch (error: unknown) {
    traceProjection(
      "rejected",
      params,
      projected,
      runningExecutionCount,
      projectionIssueCode(error),
    );
    throw error;
  }
}

export function buildRequestToolResultsMessage(
  view: RequestToolResultsView,
): ChatMessage {
  const results = projectModelVisibleRequestToolResults(view.results);
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: REQUEST_TOOL_RESULTS_MESSAGE_KIND,
      authority: "reference_data",
      sourceRevision: view.sourceRevision,
      results,
    }),
  });
}

export function buildCompactedRequestToolResultsMessage(
  view: RequestToolResultsView,
  checkpoint: SemanticCompactionCheckpoint,
): ChatMessage {
  const modelVisibleResults = projectModelVisibleRequestToolResults(
    view.results,
  );
  const availableExecutionIds = new Set(
    modelVisibleResults.map(({ executionId }) => executionId),
  );
  if (
    checkpoint.sourceDigests.some(
      ({ sourceRef }) => !availableExecutionIds.has(sourceRef),
    )
  ) {
    throw new Error("request_tool_results_compaction_source_missing");
  }
  const digestByExecutionId = new Map(
    checkpoint.sourceDigests.map((digest) => [digest.sourceRef, digest]),
  );
  const coveredExecutionIds = new Set(digestByExecutionId.keys());
  const coveredResults = modelVisibleResults
    .filter(({ executionId }) => coveredExecutionIds.has(executionId))
    .map((result) => {
      const {
        referenceData: _referenceData,
        adapterResult: _adapterResult,
        ...receipt
      } = result;
      return Object.freeze({
        ...receipt,
        sourceFingerprint: digestByExecutionId.get(result.executionId)!
          .sourceFingerprint,
      });
    });
  if (
    coveredResults.some((result) => {
      const exact = modelVisibleResults.find(
        ({ executionId }) => executionId === result.executionId,
      );
      return (
        !exact ||
        createSemanticCompactionSha256Fingerprint(JSON.stringify(exact)) !==
          result.sourceFingerprint
      );
    })
  ) {
    throw new Error("request_tool_results_compaction_fingerprint_mismatch");
  }
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: REQUEST_TOOL_RESULTS_MESSAGE_KIND,
      authority: "reference_data",
      sourceRevision: view.sourceRevision,
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
        coveredResults,
      },
      results: modelVisibleResults.filter(
        ({ executionId }) => !coveredExecutionIds.has(executionId),
      ),
    }),
  });
}

/**
 * Keeps the canonical settled-result view intact while ensuring that the
 * model-visible evidence lane carries each exact reference body only once.
 * Deduplication is allowed only when the adapter envelope mechanically owns
 * the identical string; otherwise the explicit referenceData field remains.
 */
function projectModelVisibleRequestToolResults(
  results: readonly RequestToolResult[],
): readonly RequestToolResult[] {
  return Object.freeze(
    results.map((result) => {
      if (!isReferenceDataRepresentedByAdapterResult(result)) return result;
      const { referenceData: _referenceData, ...singleCopyResult } = result;
      return Object.freeze(singleCopyResult);
    }),
  );
}

function isReferenceDataRepresentedByAdapterResult(
  result: RequestToolResult,
): boolean {
  const referenceData = result.referenceData;
  const adapterResult = result.adapterResult;
  if (!referenceData || !adapterResult) return false;
  if (adapterResult.kind === "registered_tool_execution_result_v1") {
    return adapterResult.result.output === referenceData;
  }
  if (
    adapterResult.kind === "generic_capability_result_v1" &&
    isCapabilityJsonObject(adapterResult.payload)
  ) {
    return adapterResult.payload.referenceData === referenceData;
  }
  return false;
}

function isCapabilityJsonObject(
  value: CapabilityJsonValue,
): value is CapabilityJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function traceProjection(
  event: "projected" | "rejected",
  params: Readonly<{
    head: RoleCallLedgerHead;
    modelStep: ModelStep;
    callId: string;
  }>,
  results: readonly RequestToolResult[],
  runningExecutionCount: number,
  issueCode?: string,
  sourceResults: readonly RequestToolResult[] = results,
): void {
  traceDebug(REQUEST_TOOL_RESULTS_LOG_SCOPE, event, {
    requestId: params.head.state.requestId,
    modelStep: params.modelStep,
    callId: params.callId,
    sourceRevision: params.head.revision,
    resultCount: results.length,
    executionIds: results.map(({ executionId }) => executionId),
    capabilityIds: results.map(({ capabilityId }) => capabilityId),
    outcomes: results.map(({ outcome }) => outcome),
    summaryChars: results.reduce(
      (total, { summary }) => total + summary.length,
      0,
    ),
    sourceSummaryChars: sourceResults.reduce(
      (total, { summary }) => total + summary.length,
      0,
    ),
    referenceDataChars: results.reduce(
      (total, { referenceData }) => total + (referenceData?.length ?? 0),
      0,
    ),
    sourceReferenceDataChars: sourceResults.reduce(
      (total, { referenceData }) => total + (referenceData?.length ?? 0),
      0,
    ),
    omittedReferenceDataChars:
      sourceResults.reduce(
        (total, { referenceData }) => total + (referenceData?.length ?? 0),
        0,
      ) -
      results.reduce(
        (total, { referenceData }) => total + (referenceData?.length ?? 0),
        0,
      ),
    compactedResultCount: results.filter(
      ({ summaryProjection }) =>
        summaryProjection === "superseded_target_evidence",
    ).length,
    referenceCount: results.reduce(
      (total, { references }) => total + (references?.length ?? 0),
      0,
    ),
    exactResultCount: results.filter(({ adapterResult }) => adapterResult)
      .length,
    exactResultChars: results.reduce(
      (total, { adapterResult }) =>
        total + (adapterResult ? JSON.stringify(adapterResult).length : 0),
      0,
    ),
    runningExecutionCount,
    ...(issueCode ? { issueCode } : {}),
  });
}

/**
 * Keeps every canonical execution record while replacing stale successful
 * observations with a small, explicit supersession marker. A mutation makes
 * earlier observations of the same target stale. An exact later observation
 * makes an identical earlier observation redundant. Different observations of
 * one target remain visible because they may cover complementary regions.
 */
export function projectCurrentRequestToolResults(
  results: readonly RequestToolResult[],
): RequestToolResult[] {
  const latestMutationByTarget = new Map<string, string>();
  const latestEquivalentObservation = new Map<string, string>();
  const projected = new Array<RequestToolResult>(results.length);

  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]!;
    const targets = result.references?.map(({ target }) => target) ?? [];
    const isSuccessfulObservation =
      result.outcome === "succeeded" &&
      result.observedEffect === "observation" &&
      targets.length > 0;
    const isSuccessfulMutation =
      result.outcome === "succeeded" &&
      result.observedEffect === "mutation" &&
      targets.length > 0;
    const supersedingMutationExecutionIds = isSuccessfulObservation
      ? targets
          .map((target) => latestMutationByTarget.get(target))
          .filter((executionId): executionId is string => Boolean(executionId))
      : [];
    const observationKey = isSuccessfulObservation
      ? equivalentObservationKey(result, targets)
      : undefined;
    const equivalentObservationExecutionId = observationKey
      ? latestEquivalentObservation.get(observationKey)
      : undefined;
    const isSupersededByMutation =
      isSuccessfulObservation &&
      supersedingMutationExecutionIds.length === targets.length;
    const isSupersededObservation =
      isSupersededByMutation || Boolean(equivalentObservationExecutionId);
    const supersedingExecutionIds = isSupersededByMutation
      ? supersedingMutationExecutionIds
      : equivalentObservationExecutionId
        ? [equivalentObservationExecutionId]
        : [];

    if (isSupersededObservation) {
      const {
        referenceData: _referenceData,
        adapterResult: _adapterResult,
        ...receipt
      } = result;
      projected[index] = Object.freeze({
        ...receipt,
        summary:
          "Earlier successful observation superseded by later settled evidence for the same target.",
        summaryProjection: "superseded_target_evidence" as const,
        supersededByExecutionIds: Object.freeze([
          ...new Set(supersedingExecutionIds),
        ]),
      });
    } else {
      projected[index] = result;
    }

    if (isSuccessfulMutation) {
      for (const target of targets) {
        if (!latestMutationByTarget.has(target)) {
          latestMutationByTarget.set(target, result.executionId);
        }
      }
    }
    if (
      isSuccessfulObservation &&
      observationKey &&
      !latestEquivalentObservation.has(observationKey)
    ) {
      latestEquivalentObservation.set(observationKey, result.executionId);
    }
  }

  return projected;
}

function equivalentObservationKey(
  result: RequestToolResult,
  targets: readonly string[],
): string {
  const acceptedAction = result.acceptedAction;
  return JSON.stringify([
    result.capabilityId,
    [...targets].sort(),
    ...(acceptedAction
      ? [acceptedAction.controls, acceptedAction.workingDirectory]
      : [result.summary]),
  ]);
}

function isDeclaredEffect(
  value: unknown,
): value is RoleCapabilityDeclaredEffect {
  return value === "observation" || value === "mutation" || value === "mixed";
}

function isOutcome(value: unknown): value is RoleCapabilityExecutionOutcome {
  return value === "succeeded" || value === "failed";
}

function isObservedEffect(
  value: unknown,
): value is RoleCapabilityObservedEffect {
  return (
    value === "none" ||
    value === "observation" ||
    value === "mutation" ||
    value === "indeterminate"
  );
}

function isBoundedSummary(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= ROLE_CALL_RESULT_MAX_LENGTH
  );
}

function isOptionalBoundedReferenceData(
  value: unknown,
): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH)
  );
}

function isValidReferences(
  value: RoleCallLedgerHead["state"]["capabilityExecutions"][number]["references"],
): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX &&
      value.every(
        (reference) =>
          reference.kind === "tool_target" &&
          typeof reference.target === "string" &&
          reference.target.trim().length > 0 &&
          reference.target.length <=
            ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
      ) &&
      new Set(value.map(({ target }) => target)).size === value.length)
  );
}

function projectionIssueCode(error: unknown): string {
  return error instanceof Error &&
    error.message.startsWith("request_tool_results_")
    ? error.message
    : "request_tool_results_projection_failed";
}
