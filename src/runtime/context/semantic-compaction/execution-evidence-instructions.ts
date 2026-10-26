import type { ModelStep } from "../../../shared/model-steps.js";
import { SEMANTIC_COMPACTION_INSTRUCTIONS, EXECUTION_SEMANTIC_COMPACTION_INSTRUCTIONS } from "./prompt.js";

export const EXECUTION_AGENT_COMPACTION_REQUIREMENTS = [
  "Compress the record; do not advance the task. Preserve source-established facts, decisions, failures, and progress. Update pending work only from supplied outcomes. Do not review correctness, perform unfinished analysis, infer new defects or requirements, or propose actions. Compression omissions are information limits, not new work. The execution agent alone decides what happens next.",
  "Distinguish successful retrieval or a completed source change from completion of the analysis, implementation or transformation that depends on it. Preserve supplied results and exact task-relevant identifiers, interfaces and relationships needed for that unfinished work, including names, keys, selectors, signatures and their associations. A read/write receipt or description of what a source contains cannot replace those concrete facts.",
  "If task-relevant detail still cannot fit after removing repetition and using compact records, identify exactly which task-relevant facts, identifiers or relationships were omitted and their sourceRef or supplied location in findings. Distinguish detail omitted by compaction from detail absent in the original source. A sourceRef names provenance; it does not mean the original content remains visible to the owner. Do not claim that a summary preserves full contents or completes unfinished work.",
  "",
  "Preserve exact identifiers and source-bound meanings when the current request or active assignment needs them for active targets, unfinished interfaces, comparison joins or remaining work. Unrelated inventories may be summarized without enumerating their identifiers; presence in a source or earlier digest alone does not require retention.",
  "Identifiers include paths and resource names, declared symbols and function names, object fields and schema keys, DOM IDs, CSS classes and selectors, data attributes, storage keys, and exact enum or sentinel values that participate in an interface.",
  "Deduplicate repeated occurrences into concise rows or grouped dictionaries: source/location | exact identifiers | role or binding | associated value or condition. Preserve exact spelling and keep each identifier bound to its own source and meaning. A list of disconnected names is insufficient.",
  "Preserve the supplied relationships needed between retained task-relevant identifiers, including keys used to join or select records, DOM-to-code bindings, selector-to-markup associations, and literal values that cross file or interface boundaries. Do not invent a relationship that the source does not establish.",
  "Remove narrative, repeated receipts, examples and duplicated explanations before shortening necessary identifier records. Carry forward the records still needed for the current request; reconcile relevance with supplied later outcomes without inventing completion.",
  "Use the unchanged response schema and shared checkpoint token budget. Missing or renamed task-relevant identifiers, lost necessary bindings, or an over-budget checkpoint fail this preservation requirement; disclose task-relevant omissions rather than claim complete preservation.",
  "",
  "",
  "The purpose of this checkpoint is to enable the owner to continue the current request efficiently, not to produce the shortest possible account. Omitting a fact needed for the unfinished work can force another read and another compaction, increasing total runtime and token use.",
  "Preserve a compact working representation of the supplied implementation and data contracts needed to continue the current request. Alongside exact identifiers, retain top-level data shape, field meanings and types, required or empty values, normalization rules, function inputs and outputs, identifier-to-value bindings, and the relationships by which one part uses another. Names without these associations are not a usable substitute.",
  "Keep applicable source-specific requirements, prohibitions, approval conditions, exceptions and scope limits self-contained in that sourceDigest with their original meaning and authority; continuation alone is not a substitute.",
  "Use concise source-bound rows, maps or compact pseudocode to retain those contracts. Prefer precise interface and behavior facts over appearance descriptions, repeated receipts or narrative about what was inspected. Keep existing identifier-preservation requirements and the same shared token budget; repeated occurrences can share a compact representation without losing their source associations.",
  "Before returning, check the facts needed to continue the current request against the supplied sources. Do not unnecessarily discard facts that would require recovering those same sources merely because of your summary. Distinguish truly unavailable information from information supplied here.",
  "",
].join("\n");

/** Extend only checkpoints bound exclusively to Execution Agent consumers. */
export function resolveSemanticCompactionInstructions(
  allowedConsumers: readonly ModelStep[],
): string {
  if (!hasExclusiveExecutionAgentConsumers(allowedConsumers)) {
    return SEMANTIC_COMPACTION_INSTRUCTIONS;
  }
  return [
    EXECUTION_SEMANTIC_COMPACTION_INSTRUCTIONS,
    EXECUTION_AGENT_COMPACTION_REQUIREMENTS,
  ].join("\n");
}

function hasExclusiveExecutionAgentConsumers(
  allowedConsumers: readonly ModelStep[],
): boolean {
  if (allowedConsumers.length === 0) return false;
  return allowedConsumers.every(isExecutionAgentConsumer);
}

function isExecutionAgentConsumer(consumer: ModelStep): boolean {
  return consumer === "execution.decision" || consumer === "execution.response";
}
