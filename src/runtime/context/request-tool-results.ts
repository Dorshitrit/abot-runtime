import { projectCurrentRequestToolResults } from "./request-tool-results-supersession.js";
export { projectCurrentRequestToolResults } from "./request-tool-results-supersession.js";
import { bindSuperWorkerCompactionSources } from "./super-worker-compaction-sidecar.js";
import { projectSingleCopyCapabilityResult } from "./capability-result-compaction-source.js";
import { projectCanonicalRequestToolResult } from "./canonical-capability-result.js";
import { projectSuperCompactedRequestToolResults } from "./super-request-tool-results-checkpoint.js";
import type { SuperCompactionIntegrityInput } from "./semantic-compaction/super-source-integrity.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import {
  type RoleCallLedger,
  type RoleCallLedgerHead,
  type RoleCapabilityDeclaredEffect,
  type RoleCapabilityExecutionOutcome,
  type RoleCapabilityObservedEffect,
  type RoleCapabilityResultReference,
} from "../orchestration/role-calls/index.js";
import { projectWorkerCapabilityPlannerItemBinding } from "../orchestration/worker-capabilities/assignment-provenance.js";
import { traceDebug } from "../observability/debug-logger.js";
import { type CapabilityAdapterResult } from "../orchestration/capability-adapters/result.js";
import { bindRequestToolResultsMessage } from "./request-tool-results-message-binding.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionCheckpoint,
} from "./semantic-compaction/index.js";
import { type AcceptedCapabilityAction } from "./accepted-capability-action.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "./semantic-compaction/evidence-scope.js";

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
  scope?: Readonly<{ kind: "call"; callId: string }>;
}>;

/**
 * Projects settled capability results in canonical ledger order. Direct
 * Planner-owned Workers receive only their exact call lane; other roles keep
 * request-wide summaries. Complete reference data is projected only back to
 * the exact call that produced it.
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
    const call = params.head.state.calls.find(
      ({ callId }) => callId === params.callId,
    );
    if (!call) {
      throw new Error("request_tool_results_call_invalid");
    }
    const plannerItemScoped =
      projectWorkerCapabilityPlannerItemBinding(params.head, call) !==
      undefined;

    for (const execution of params.head.state.capabilityExecutions) {
      if (execution.status === "running") {
        runningExecutionCount += 1;
        continue;
      }
      const sourceResult = projectCanonicalRequestToolResult(
        params.head,
        execution,
      );
      sourceProjected.push(sourceResult);
      if (plannerItemScoped && execution.callId !== params.callId) continue;
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
    const view = bindSuperWorkerCompactionSources(
      {
        sourceRevision: params.head.revision,
        results: Object.freeze(currentResults),
        ...(plannerItemScoped
          ? {
              scope: Object.freeze({
                kind: "call" as const,
                callId: params.callId,
              }),
            }
          : {}),
      },
      params.head,
      params.callId,
    );
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
  return bindRequestToolResultsMessage(
    view,
    JSON.stringify({
      kind: REQUEST_TOOL_RESULTS_MESSAGE_KIND,
      authority: "reference_data",
      sourceRevision: view.sourceRevision,
      ...(view.scope ? { coverage: view.scope } : {}),
      results,
    }),
  );
}

export function buildCompactedRequestToolResultsMessage(
  view: RequestToolResultsView,
  checkpoint: SemanticCompactionCheckpoint,
  integrity?: SuperCompactionIntegrityInput,
): ChatMessage {
  if (integrity)
    return projectSuperCompactedRequestToolResults(
      view,
      checkpoint,
      integrity,
      buildRequestToolResultsMessage(view),
    );
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
  return bindRequestToolResultsMessage(
    view,
    JSON.stringify({
      kind: REQUEST_TOOL_RESULTS_MESSAGE_KIND,
      authority: "reference_data",
      sourceRevision: view.sourceRevision,
      ...(view.scope ? { coverage: view.scope } : {}),
      semanticCheckpoint: {
        kind: checkpoint.kind,
        evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
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
  );
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
  return Object.freeze(results.map(projectSingleCopyCapabilityResult));
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

function projectionIssueCode(error: unknown): string {
  return error instanceof Error &&
    error.message.startsWith("request_tool_results_")
    ? error.message
    : "request_tool_results_projection_failed";
}
