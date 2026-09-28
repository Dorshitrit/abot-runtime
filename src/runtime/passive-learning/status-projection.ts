import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningBatch, LearningBatchSummary } from "./contracts.js";

export function summarizeBatch({
  observations,
  reviewProgress: _reviewProgress,
  ...summary
}: LearningBatch): LearningBatchSummary {
  return { ...summary, observationCount: observations.length };
}

/** Fetch canonical records so deletion cannot leave stale saved-memory previews. */
export async function recentLearningMemories(
  memory: LongTermMemoryService,
  history: readonly LearningBatch[],
): Promise<
  readonly Readonly<{ id: string; content: string; createdAt: string }>[]
> {
  const ids = new Set(
    history
      .filter((batch) => batch.status === "saved")
      .slice(-3)
      .reverse()
      .flatMap((batch) => [...batch.recordIds].reverse()),
  );
  if (!ids.size) return [];
  try {
    const found: { id: string; content: string; createdAt: string }[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await memory.list({
        offset,
        limit: 100,
        origin: "passive_observation",
      });
      found.push(
        ...page.items
          .filter((record) => ids.has(record.id))
          .map(({ id, content, createdAt }) => ({ id, content, createdAt })),
      );
      if (found.length >= ids.size || offset + 100 >= page.total) break;
    }
    const byId = new Map(found.map((record) => [record.id, record]));
    return [...ids]
      .flatMap((id) => {
        const record = byId.get(id);
        return record ? [record] : [];
      })
      .slice(0, 3);
  } catch {
    return [];
  }
}

export function learningFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return "learning_failed";
  if (/^bridge_request_failed:\d{3}(?::|$)/u.test(error.message)) return "learning_model_request_failed";
  const safe = [
    "learning_model_request_failed",
    "learning_model_required",
    "learning_model_profile_unavailable",
    "learning_model_profile_overridden",
    "learning_memory_unavailable",
    "learning_host_unavailable",
    "learning_storage_unavailable",
    "learning_batch_timeout",
    "learning_disabled",
    "learning_processing_paused",
    "learning_application_processing_excluded",
    "learning_pending_deleted",
    "learning_stopped",
    "learning_batch_expired",
    "learning_interactive_preempted",
    "learning_generation_superseded",
    "learning_observation_exceeds_context",
    "learning_review_context_exceeds_budget",
    "learning_review_progress_capacity",
    "learning_review_progress_storage_unavailable",
    "learning_review_progress_invalid",
    "learning_review_progress_expired",
    "co_worker_review_stage_limit_invalid",
    "co_worker_review_stage_order_invalid",
    "learning_partition_capacity",
    "request_context_final_envelope_exceeds_window",
    "request_context_required_content_exceeds_budget",
    "learning_proposal_source_unknown",
    "learning_knowledge_conflict",
    "learning_embedding_reindex_required",
    "learning_memory_protected",
    "learning_receipt_capacity",
    "learning_duplicate_requires_bound_update",
    // Exact, content-free codes from learning decisions and memory persistence.
    "learning_action_invalid",
    "learning_candidate_certainty_corrupt",
    "learning_candidate_embedding_missing",
    "learning_candidate_expired",
    "learning_candidate_identity_conflict",
    "learning_candidate_identity_duplicate",
    "learning_candidate_score_corrupt",
    "learning_candidate_vector_binding_corrupt",
    "learning_candidate_vector_corrupt",
    "learning_candidates_corrupt",
    "learning_certainty_invalid",
    "learning_content_exceeds_limit",
    "learning_content_invalid",
    "learning_content_sensitive",
    "learning_create_target_invalid",
    "learning_decision_invalid",
    "learning_decision_list_invalid",
    "learning_decision_source_unknown",
    "learning_decision_target_repeated",
    "learning_decision_target_unknown",
    "learning_decisions_invalid",
    "learning_output_invalid_json",
    "learning_output_object_required",
    "learning_output_decisions_missing",
    "learning_output_decisions_not_array",
    "learning_output_decision_limit",
    "learning_maturation_policy_invalid",
    "learning_maturation_store_corrupt",
    "learning_merge_binding_invalid",
    "learning_merge_source_unknown",
    "learning_proposal_device_mismatch",
    "learning_proposal_source_required",
    "learning_reason_invalid",
    "learning_receipts_corrupt",
    "learning_reconsideration_invalid",
    "learning_reconsideration_not_future",
    "learning_reinforcement_invalid",
    "learning_review_action_invalid",
    "learning_review_output_contract_invalid",
    "learning_review_cannot_raise_score",
    "learning_review_cannot_reinforce",
    "learning_review_cause_invalid",
    "learning_review_observations_unexpected",
    "learning_review_target_not_due",
    "learning_score_invalid",
    "learning_target_invalid",
    "learning_target_kind_invalid",
    "long_term_memory_embedding_binding_changed",
    "long_term_memory_embedding_input_empty",
    "long_term_memory_embedding_response_invalid",
    "long_term_memory_embedding_vector_count_invalid",
    "invalid_learning_batch_expiry",
    "co_worker_model_daily_budget_exhausted",
    "co_worker_embedding_daily_budget_exhausted",
    "co_worker_embedding_character_budget_exhausted",
    "co_worker_resources_busy",
    "invalid_learning_batch",
    "invalid_learning_proposal",
    "invalid_learning_state",
    "output_incomplete",
    "host_broker_unavailable",
    "host_not_paired",
    "host_disconnected",
    "host_observations_unsupported",
    "host_observations_already_owned",
    "host_observation_connect_timeout",
    "host_observation_cancelled",
  ];
  return safe.includes(error.message) ? error.message : "learning_failed";
}
