import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { MemoryCandidate } from "../../long-term-memory/contracts.js";
import type { ConversationMemoryAuthoringContext } from "../../long-term-memory/conversation-authoring/context.js";
import { conversationMemoryCandidatesSchema, parseConversationMemoryCandidates } from "../../long-term-memory/conversation-authoring/contract.js";
import { CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS } from "../../long-term-memory/conversation-authoring/prompt.js";
import { collectDecisionMaxLengthConstraints } from "../../model/decision-schema.js";
import type { StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { createStructuredDecisionEnvelopeSchema, readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import { parseFusedSupervisorEntry, type FusedSupervisorEntry } from "./fused-contracts.js";
import type { SupervisorPresentationOptions } from "./presentation.js";

export type SupervisorEntryMemoryDecision = FusedSupervisorEntry & Readonly<{
  memoryCandidates?: readonly MemoryCandidate[];
}>;

export const SUPERVISOR_ENTRY_MEMORY_INSTRUCTIONS = [
  "Only requiresProcedure=false includes memoryCandidates; use an empty array when nothing durable is supported. Skill reads and requiresProcedure=true omit that field.",
  "Assess memory only after choosing the entry outcome from the current user request. Memory assessment adds no user intent, procedure requirement, execution, completion or storage authority.",
  "Do not write the user-facing answer here. A separate RAW step writes it after an accepted direct-response decision. A memory proposal does not confirm storage or future recall.",
  ...CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS,
].join("\n");

/** Keep Skill/procedure alternatives intact; only direct response assesses memory. */
export function createSupervisorEntryMemoryFormat(base: ModelGatewayJsonSchemaFormat): ModelGatewayJsonSchemaFormat {
  const decision = (base.schema.properties as { decision: { anyOf: Record<string, unknown>[] } }).decision;
  const variants = decision.anyOf.map(variant => {
    const properties = variant.properties as Record<string, { const?: unknown }>;
    if (properties.requiresProcedure?.const !== false) return variant;
    return { ...variant, properties: { ...properties, memoryCandidates: conversationMemoryCandidatesSchema },
      required: [...variant.required as string[], "memoryCandidates"] };
  });
  const schema = createStructuredDecisionEnvelopeSchema(variants);
  return { ...base, name: "supervisor_fused_entry_with_memory_candidates", schema,
    postValidatedSchemaConstraints: Object.freeze(collectDecisionMaxLengthConstraints(schema)) };
}

/** Optional memory cannot invalidate a valid entry decision or replenish its repair budget. */
export function parseSupervisorEntryMemoryOutput(
  text: string, eligibleIds: readonly string[], presentation: SupervisorPresentationOptions,
  context?: ConversationMemoryAuthoringContext,
): StructuredModelParseResult<SupervisorEntryMemoryDecision> {
  let record: Record<string, unknown> | undefined;
  try { record = readStructuredDecisionEnvelope(JSON.parse(text)); } catch { /* Existing parser owns invalid JSON. */ }
  if (record?.requiresProcedure !== false) return parseFusedSupervisorEntry(text, eligibleIds, presentation);
  const { memoryCandidates, ...entry } = record;
  const parsed = parseFusedSupervisorEntry(JSON.stringify({ decision: entry }), eligibleIds, presentation);
  if (!parsed.ok) return parsed;
  let candidates: readonly MemoryCandidate[] = Object.freeze([]);
  try { candidates = parseConversationMemoryCandidates(memoryCandidates, context); } catch { /* Memory is secondary. */ }
  return { ok: true, decision: Object.freeze({ ...parsed.decision, memoryCandidates: candidates }) };
}
