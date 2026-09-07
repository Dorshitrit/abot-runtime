import type { ChatMessage } from "../../model-gateway/types.js";
import type { LongTermMemoryRecord } from "./contracts.js";
import { projectMemoryRecallContinuations } from "./recall-continuation.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import {
  ROLE_MEMORY_RECALL_RECORD_LIMIT_MAX,
  ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH,
  type RoleMemoryRecall,
} from "../orchestration/role-calls/memory-recall-contract.js";

export const MEMORY_RECALL_REFERENCE_KIND =
  "runtime_memory_recall_reference_v1";

export type RecallProjection = Readonly<{
  recallId: string;
  invocationAttempt: number;
  completedChildCount: number;
  query: string;
  outcome: string;
  memories: readonly LongTermMemoryRecord[];
  omittedRecordCount: number;
  reason?: string;
}>;

type RecallProjectionScope = Readonly<{
  requestId: string;
  callId: string;
  steeringVersion: number;
  recallCount: number;
  recordCount: number;
}>;

/** Derive context only from settled receipts belonging to the current root intent. */
export function projectRootMemoryRecallMessage(params: {
  head: RoleCallLedgerHead;
  callId: string;
  steeringVersion: number;
}): ChatMessage | undefined {
  if (params.callId !== params.head.state.rootCallId) return undefined;
  const recalls = params.head.state.memoryRecalls.filter((recall) =>
    isCurrentSettledMemoryRecall(recall, params),
  );
  if (recalls.length === 0) return undefined;
  const scope: RecallProjectionScope = {
    requestId: params.head.state.requestId,
    callId: params.callId,
    steeringVersion: params.steeringVersion,
    recallCount: recalls.length,
    recordCount: recalls.reduce(
      (count, recall) =>
        count +
        recall.result!.records.length +
        recall.result!.omittedRecordCount,
      0,
    ),
  };
  const selected: RecallProjection[] = [];
  const includedIds = new Set<string>();
  for (const recall of [...recalls].reverse()) {
    const projection = selectRecallProjection(
      recall,
      selected,
      includedIds,
      scope,
    );
    if (!projection) continue;
    selected.unshift(projection);
    for (const record of projection.memories) includedIds.add(record.id);
  }
  return Object.freeze({
    role: "system",
    content: serializeRecallProjection(scope, selected),
  });
}

function isCurrentSettledMemoryRecall(
  recall: RoleMemoryRecall,
  scope: Readonly<{ callId: string; steeringVersion: number }>,
): boolean {
  if (recall.callId !== scope.callId) return false;
  if (recall.steeringVersion !== scope.steeringVersion) return false;
  if (recall.status !== "settled") return false;
  return recall.result?.outcome !== "superseded";
}

function selectRecallProjection(
  recall: RoleMemoryRecall,
  selected: readonly RecallProjection[],
  includedIds: ReadonlySet<string>,
  scope: RecallProjectionScope,
): RecallProjection | undefined {
  const result = recall.result!;
  const base = {
    recallId: recall.recallId,
    invocationAttempt: recall.invocationAttempt,
    completedChildCount: recall.completedChildCount,
    query: recall.query,
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
  };
  const records: LongTermMemoryRecord[] = [];
  const project = (): RecallProjection => ({
    ...base,
    memories: Object.freeze([...records]),
    omittedRecordCount:
      result.omittedRecordCount + result.records.length - records.length,
  });
  if (!fitsRecallProjection(scope, [project(), ...selected])) return undefined;
  for (const record of result.records) {
    if (includedIds.has(record.id)) continue;
    if (
      includedIds.size + records.length >=
      ROLE_MEMORY_RECALL_RECORD_LIMIT_MAX
    )
      break;
    records.push(record);
    if (!fitsRecallProjection(scope, [project(), ...selected])) records.pop();
  }
  return Object.freeze(project());
}

function fitsRecallProjection(
  scope: RecallProjectionScope,
  recalls: readonly RecallProjection[],
): boolean {
  const content = serializeRecallProjection(scope, recalls);
  if (content.length > ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH) return false;
  const continuations = projectMemoryRecallContinuations({
    role: "system",
    content,
  });
  return (
    JSON.stringify(continuations.flatMap(({ messages }) => messages)).length <=
    ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH
  );
}

function serializeRecallProjection(
  scope: RecallProjectionScope,
  recalls: readonly RecallProjection[],
): string {
  const shownRecords = recalls.reduce(
    (count, recall) => count + recall.memories.length,
    0,
  );
  return JSON.stringify({
    kind: MEMORY_RECALL_REFERENCE_KIND,
    authority: "passive_reference",
    purpose: "answer_the_active_roots_explicit_memory_queries",
    requestId: scope.requestId,
    callId: scope.callId,
    steeringVersion: scope.steeringVersion,
    applicability: "only_this_root_request_and_steering_version",
    presenceEffect:
      "not_user_intent_assignment_action_authority_or_completion_evidence",
    omissionPolicy:
      "newest_recalls_first_whole_records_newest_occurrence_per_memory_id",
    omittedRecallCount: scope.recallCount - recalls.length,
    omittedRecordCount: scope.recordCount - shownRecords,
    recalls,
  });
}
