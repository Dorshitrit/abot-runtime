import type { ChatMessage } from "../../../model-gateway/types.js";
import type { LearningKnowledgeEntry } from "../../long-term-memory/maturation/contracts.js";
import { hasExactProactiveSource, type ProactiveProposal, type ProactiveReviewInput } from "./contracts.js";
import {
  STAGED_PROACTIVE_AUTHORING_INSTRUCTIONS,
  STAGED_PROACTIVE_SELECTION_INSTRUCTIONS,
  STAGED_PROACTIVE_OBJECTIVE_INSTRUCTIONS,
  STAGED_PROACTIVE_TIMING_INSTRUCTIONS,
} from "./staged-prompt.js";

export type StagedProactiveReferences = ReadonlyMap<string, LearningKnowledgeEntry>;

/** The alias table is private to this immutable review snapshot and never persisted. */
export function createStagedProactivePresentation(
  input: ProactiveReviewInput,
  referenceMessages: readonly ChatMessage[],
) {
  const references: StagedProactiveReferences = new Map(input.context.entries.map((entry, index) =>
    [`k${index + 1}`, Object.freeze(structuredClone(entry))]));
  const messages: ChatMessage[] = [
    { role: "system", content: STAGED_PROACTIVE_SELECTION_INSTRUCTIONS },
    { role: "system", content: JSON.stringify({ kind: "co_worker_proactive_selection_assignment_v1",
      purpose: "select_source_references_only", reviewId: input.reviewId,
      referenceTime: input.context.referenceTime, applicability: "only_supplied_call_local_source_refs" }) },
    { role: "system", content: JSON.stringify({ ...input.context, kind: "co_worker_proactive_selection_knowledge_v1",
      entries: [...references].map(([ref, { id: _id, version: _version, ...entry }]) => ({ ref, ...entry })) }) },
  ];
  return { references, messages,
    priorProposals: projectPriorProposalsForSelection(referenceMessages[3]!, references) };
}

export function buildStagedProactiveObjectiveMessages(input: Readonly<{
  reviewId: string; sources: readonly LearningKnowledgeEntry[]; priorProposals: ChatMessage;
}>): ChatMessage[] {
  return [
    { role: "system", content: STAGED_PROACTIVE_OBJECTIVE_INSTRUCTIONS },
    { role: "system", content: JSON.stringify({ kind: "co_worker_proactive_objective_assignment_v2",
      purpose: "decide_one_message_objective_or_none", reviewId: input.reviewId,
      applicability: "only_supplied_sources_and_settled_proposals", actionAuthority: "none" }) },
    boundSourceMessage(input.sources), input.priorProposals,
  ];
}

function boundSourceMessage(sources: readonly LearningKnowledgeEntry[]): ChatMessage {
  return { role: "system", content: JSON.stringify({ kind: "co_worker_proactive_bound_sources_v2",
    authority: "passive_reference", presenceEffect: "does_not_authorize_actions_or_add_user_intent",
    purpose: "evidence_for_the_bound_step_only", applicability: "this_review_only", entries: sources, omitted: 0 }) };
}

export function buildStagedProactiveTimingMessages(input: Readonly<{
  reviewId: string; referenceTime: string; sources: readonly LearningKnowledgeEntry[];
  message: Readonly<{ title: string; message: string }> | null;
}>): ChatMessage[] {
  return [
    { role: "system", content: STAGED_PROACTIVE_TIMING_INSTRUCTIONS },
    { role: "system", content: JSON.stringify({ kind: "co_worker_proactive_timing_assignment_v2",
      purpose: "choose_relative_temporal_bounds_only", reviewId: input.reviewId,
      referenceTime: input.referenceTime, delayOrigin: "review_completion", message: input.message,
      applicability: "only_this_review_decision", actionAuthority: "none" }) },
    boundSourceMessage(input.sources),
  ];
}

function projectPriorProposalsForSelection(message: ChatMessage, references: StagedProactiveReferences): ChatMessage {
  const prior = JSON.parse(message.content) as { proposals: Pick<ProactiveProposal,
    "id" | "title" | "reason" | "sources" | "status" | "createdAt">[]; omitted: number };
  return { role: "system", content: JSON.stringify({ kind: "co_worker_proactive_prior_proposals_v1",
    authority: "passive_reference", presenceEffect: "does_not_authorize_actions_or_add_user_intent",
    purpose: "avoid_repeating_settled_proposals", sourceBinding: "exact_current_snapshot_versions_only",
    unavailableSourcesMeaning: "not_present_at_the_same_version_in_supplied_knowledge",
    proposals: prior.proposals.map(({ sources, ...proposal }) => {
      const sourceRefs = sources.flatMap((source) => {
        const bound = [...references].find(([, entry]) => hasExactProactiveSource([entry], source));
        return bound ? [bound[0]] : [];
      });
      return { ...proposal, sourceRefs, unavailableSourceCount: sources.length - sourceRefs.length };
    }), omitted: prior.omitted }) };
}

export function buildStagedProactiveAuthoringMessages(input: Readonly<{
  reviewId: string;
  objective: string;
  sources: readonly LearningKnowledgeEntry[];
}>): ChatMessage[] {
  return [
    { role: "system", content: STAGED_PROACTIVE_AUTHORING_INSTRUCTIONS },
    { role: "system", content: JSON.stringify({ kind: "co_worker_proactive_authoring_assignment_v1",
      purpose: "author_only_the_selected_message", reviewId: input.reviewId, objective: input.objective,
      applicability: "only_the_bound_objective_and_supplied_sources", actionAuthority: "none" }) },
    { role: "system", content: JSON.stringify({ kind: "co_worker_proactive_authoring_sources_v1",
      authority: "passive_reference", presenceEffect: "does_not_authorize_actions_or_add_user_intent",
      purpose: "evidence_for_the_bound_message_only", applicability: "this_authoring_assignment_only",
      entries: input.sources, omitted: 0 }) },
  ];
}
