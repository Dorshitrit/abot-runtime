import type { ChatMessage } from "../../../model-gateway/types.js";
import { projectCanonicalRequestToolResult } from "../../context/canonical-capability-result.js";
import { projectCompactedCapabilityResultReceipt } from "../../context/compacted-capability-result-receipt.js";
import { resolveExecutionCompactedSources } from "../../context/execution-compacted-evidence.js";
import { projectExecutionCompactionObjective } from "../../context/execution-compaction-objective.js";
import {
  buildRequestToolResultsMessage,
  type RequestToolResultsView,
} from "../../context/request-tool-results.js";
import { bindRequestToolResultsMessage } from "../../context/request-tool-results-message-binding.js";
import { isSuccessfulCoreSkillRead } from "../../knowledge-skills/read-evidence.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";

/** Reuse only the caller's captured guidance, never its continuation or live Store. */
export function buildPlannerSkillGuidanceMessage(
  request: RequestExecutionSeed,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): ChatMessage | undefined {
  const caller = head.state.calls.find(
    ({ callId }) => callId === call.parentCallId,
  );
  if (
    head.state.requestId !== request.requestId ||
    head.state.phase !== "running" ||
    head.state.activeCallId !== call.callId ||
    !head.state.calls.includes(call) ||
    call.roleId !== "planner" ||
    call.status !== "active" ||
    caller?.roleId !== "supervisor" ||
    caller.parentCallId !== null ||
    caller.status !== "waiting_for_child" ||
    !caller.childCallIds.includes(call.callId)
  )
    throw new Error("planner_graph_skill_caller_invalid");

  const results = head.state.capabilityExecutions
    .filter(
      (execution) =>
        execution.callId === caller.callId &&
        execution.status === "settled" &&
        isSuccessfulCoreSkillRead(
          execution.capabilityId,
          execution.outcome,
          execution.exactResult,
        ),
    )
    .map((execution) => projectCanonicalRequestToolResult(head, execution));
  if (results.length === 0) return undefined;

  const compacted = resolveExecutionCompactedSources({
    requestId: request.requestId,
    prompt: request.prompt,
    objective: projectExecutionCompactionObjective(
      request.prompt,
      resolveRequestSteeringInbox(request.requestSteering).snapshot().updates,
    ),
    callId: caller.callId,
    store: request.contextCompactionStore,
    results: results.map((result) => ({ ...result, adapterResult: result.adapterResult })),
  });
  const digests = new Map(
    compacted?.sources.map((source) => [source.executionId, source]),
  );
  const view: RequestToolResultsView = Object.freeze({
    sourceRevision: head.revision,
    results: Object.freeze(
      results.map((result) =>
        digests.has(result.executionId)
          ? projectCompactedCapabilityResultReceipt(result)
          : result,
      ),
    ),
  });
  const message = buildRequestToolResultsMessage(view);
  return bindRequestToolResultsMessage(
    view,
    JSON.stringify({
      ...JSON.parse(message.content),
      purpose: "skill_guidance_for_the_current_assignment",
      presenceEffect:
        "procedural_guidance_not_user_intent_criteria_or_completion_evidence",
      callerCallId: caller.callId,
      ...(compacted
        ? {
            compactedSourceEvidence: compacted.sources.map((source) => ({
              ...source,
              kind: "runtime_compacted_source_evidence_v1",
              authority: "passive_reference_only",
              omissionMeaning: "summarized_detail_not_proven_absent",
            })),
          }
        : {}),
    }),
  );
}
