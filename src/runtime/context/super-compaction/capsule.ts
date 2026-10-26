import type { ChatMessage } from "../../../model-gateway/types.js";
import type { SemanticCompactionSourceSlice } from "../semantic-compaction/chunking.js";
import {
  buildSuperCompactionInstructions,
  type SuperCompactionStage,
} from "./instructions.js";

export type SuperCompactionDerivedContext = Readonly<{
  coverage?: string;
  content?: string;
}>;

/** Serialize once: every stage sees the exact same passive evidence bytes. */
export function createSuperCompactionCapsule(params: {
  currentRequest: string;
  authority?: "prior_conversation" | "settled_evidence";
  assignment: Readonly<Record<string, unknown>>;
  sourceSlice: SemanticCompactionSourceSlice;
  previousContinuation?: string;
}): readonly ChatMessage[] {
  return Object.freeze([
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: "runtime_super_compaction_capsule_v1",
        authority: params.authority ?? "settled_evidence",
        purpose: "compress_the_bound_evidence_for_its_existing_consumer",
        applicability: "the_bound_source_and_supplied_range_only",
        presenceEffect: "no_new_user_intent_actions_routing_or_completion",
        omissionMeaning: "not_visible_does_not_mean_absent",
        currentRequest: params.currentRequest,
        assignment: params.assignment,
        sourceSlice: params.sourceSlice,
        ...(params.previousContinuation === undefined
          ? {}
          : {
              previousContinuation: {
                authority: "derived_handoff_from_previously_supplied_evidence",
                content: params.previousContinuation,
              },
            }),
      }),
    }),
  ]);
}

export function buildSuperCompactionStageMessages(params: {
  stage: SuperCompactionStage;
  baseMessages: readonly ChatMessage[];
  maxCharacters: number;
  derived?: SuperCompactionDerivedContext;
}): ChatMessage[] {
  if (!hasSinglePassiveBaseMessage(params.baseMessages))
    throw new Error("super_compaction_base_capsule_invalid");
  const baseCapsule = JSON.parse(params.baseMessages[0]!.content) as unknown;
  return [
    {
      role: "system",
      content: buildSuperCompactionInstructions(
        params.stage,
        params.maxCharacters,
      ),
    },
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: "runtime_super_compaction_stage_input_v1",
        authority: "passive_compaction_context",
        purpose: "present_one_frozen_base_with_prior_stage_outputs",
        presenceEffect: "no_new_user_intent_actions_routing_or_completion",
        baseCapsule,
        derivedStageOutputs: {
          authority:
            "model_authored_reference_not_source_fact_or_new_instruction",
          purpose: "carry_previous_outputs_without_redeciding_their_assignment",
          outputs: params.derived ?? {},
        },
      }),
    }),
  ];
}

function hasSinglePassiveBaseMessage(
  messages: readonly ChatMessage[],
): boolean {
  if (messages.length !== 1) return false;
  return messages[0]!.role === "user";
}
