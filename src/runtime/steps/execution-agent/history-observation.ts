import { hasExecutionHistoryAuthority } from "../../context/execution-history-policy.js";
import { EXECUTION_TOOL_OBSERVATION_KIND } from "../../../sessions/memory/execution-observation.js";
import { projectCanonicalRequestToolResult } from "../../context/canonical-capability-result.js";
import { projectSingleCopyCapabilityResult } from "../../context/capability-result-compaction-source.js";
import { resolveExecutionEvidenceCheckpoint } from "../../context/execution-compaction-checkpoint-selection.js";
import { projectExecutionCompactionObjective } from "../../context/execution-compaction-objective.js";
import type { SemanticCompactionDigest } from "../../context/semantic-compaction/contracts.js";
import type { RoleCallFrame, RoleCallLedgerHead, RoleCapabilityExecution } from "../../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import type { RequestObservation } from "../../request/result.js";
import { buildExecutionCapabilityResultSource } from "./capability-result-context.js";

/** Save one representation of settled EA tool evidence beside its conversation turn. */
export function projectExecutionHistoryObservation(
  request: RequestExecutionScope,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): RequestObservation | undefined {
  if (!hasExecutionHistoryAuthority(request.executionPolicy.authority)) return undefined;
  if (!isBoundExecutionHistorySource(request, head, call))
    throw new Error("execution_history_source_binding_invalid");
  const executions = head.state.capabilityExecutions.filter(function isSettledRootExecution(execution) {
    return execution.callId === call.callId && execution.status === "settled";
  });
  if (executions.length === 0) return undefined;
  const updates = resolveRequestSteeringInbox(request.requestSteering).snapshot().updates;
  const checkpoint = resolveExecutionEvidenceCheckpoint({
    requestId: request.requestId,
    prompt: request.prompt,
    objective: projectExecutionCompactionObjective(request.prompt, updates),
    callId: call.callId,
    store: request.contextCompactionStore,
    updates,
    sourceRevision: head.revision,
  });
  const digests = new Map(checkpoint?.sourceDigests.map((source) => [source.sourceRef, source]));
  return {
    observationContent: JSON.stringify({
      kind: EXECUTION_TOOL_OBSERVATION_KIND,
      requestId: request.requestId,
      results: executions.map((execution) => projectHistoricalResult(head, execution, digests)),
    }),
  };
}

function projectHistoricalResult(
  head: RoleCallLedgerHead,
  execution: RoleCapabilityExecution,
  digests: ReadonlyMap<string, SemanticCompactionDigest>,
) {
  const canonical = projectSingleCopyCapabilityResult(projectCanonicalRequestToolResult(head, execution));
  const { acceptedAction: _action, ...historical } = canonical;
  const result = omitRequestScopedMedia(historical);
  const digest = digests.get(`tool-result:${execution.executionId}`);
  if (!digest) return projectOriginalHistoricalResult(result);
  const source = buildExecutionCapabilityResultSource(head, execution);
  if (digest.sourceFingerprint !== source.sourceFingerprint)
    return projectOriginalHistoricalResult(result);
  const { adapterResult: _adapter, referenceData: _reference, summary: _summary, ...receipt } = result;
  return { ...receipt, representation: "compacted" as const, summary: digest.digest };
}

function isBoundExecutionHistorySource(
  request: RequestExecutionScope,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): boolean {
  if (head.state.requestId !== request.requestId) return false;
  return head.state.rootCallId === call.callId;
}

/** Image handles expire when the producing request closes; retain its textual evidence. */
function omitRequestScopedMedia(result: ReturnType<typeof projectSingleCopyCapabilityResult>) {
  const adapter = result.adapterResult;
  if (adapter?.kind !== "registered_tool_execution_result_v1" || !adapter.result.media) return result;
  const { media: _media, ...textualResult } = adapter.result;
  return { ...result, adapterResult: { ...adapter, result: textualResult } };
}

function projectOriginalHistoricalResult(result: ReturnType<typeof omitRequestScopedMedia>) {
  if (!hasDuplicateHistoricalSummary(result)) return { ...result, representation: "original" as const };
  const { summary: _summary, ...singleCopy } = result;
  return { ...singleCopy, representation: "original" as const };
}

function hasDuplicateHistoricalSummary(result: ReturnType<typeof omitRequestScopedMedia>): boolean {
  const adapter = result.adapterResult;
  if (adapter?.kind !== "registered_tool_execution_result_v1") return false;
  return result.summary === adapter.result.output;
}
