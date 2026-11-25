import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { MemoryCandidate } from "../../long-term-memory/contracts.js";
import type { ConversationMemoryAuthoringContext } from "../../long-term-memory/conversation-authoring/context.js";
import { conversationMemoryCandidatesSchema, parseConversationMemoryCandidates } from "../../long-term-memory/conversation-authoring/contract.js";
import { CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS } from "../../long-term-memory/conversation-authoring/prompt.js";
import { collectDecisionMaxLengthConstraints } from "../../model/decision-schema.js";
import type { StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { createStructuredDecisionEnvelopeSchema, readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import type { SupervisorRoutingDecision } from "./contracts.js";

export type SupervisorMemoryRoutingOutput = Readonly<{
  decision: SupervisorRoutingDecision;
  /** Presence, including [], means this accepted respond already assessed memory. */
  memoryCandidates?: readonly MemoryCandidate[];
}>;

export function buildSupervisorMemoryRoutingInstructions(): string {
  return [
    "Only action=respond includes memoryCandidates. Use an empty array when nothing durable is supported; all other actions omit the field.",
    "This memory-only assessment grants no routing, execution, completion or storage authority. A later presentation-only step writes the user response; do not write that response here.",
    "Memory proposals are not proof of permanent storage or future recall. Preserve the existing requirements for responding or continuing required work.",
    ...CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS,
  ].join("\n");
}

/** Extend only terminal respond; routing variants and the canonical envelope remain intact. */
export function createSupervisorMemoryRoutingFormat(baseFormat: ModelGatewayJsonSchemaFormat): ModelGatewayJsonSchemaFormat {
  const variants = readDecisionVariants(baseFormat).map((variant) => {
    const properties = asRecord(variant.properties);
    const action = asRecord(properties?.action);
    if (!Array.isArray(action?.enum) || !action.enum.includes("respond")) return variant;
    return {
      ...variant,
      properties: { ...properties, memoryCandidates: conversationMemoryCandidatesSchema },
      required: [...new Set([...(variant.required as readonly string[]), "memoryCandidates"])],
    };
  });
  const schema = createStructuredDecisionEnvelopeSchema(variants);
  return {
    ...baseFormat, name: "supervisor_decision_with_memory_candidates", schema,
    postValidatedSchemaConstraints: Object.freeze(collectDecisionMaxLengthConstraints(schema)),
  };
}

/** Memory decoding cannot invalidate an otherwise accepted routing decision. */
export function parseSupervisorMemoryRoutingOutput(
  text: string,
  parseRouting: (text: string) => StructuredModelParseResult<SupervisorRoutingDecision>,
  context?: ConversationMemoryAuthoringContext,
): StructuredModelParseResult<SupervisorMemoryRoutingOutput> {
  const record = decodeDecision(text);
  const routingText = removeRespondMemoryCandidates(text, record);
  const parsed = parseRouting(routingText);
  if (!parsed.ok) return parsed;
  if (parsed.decision.action !== "respond")
    return { ok: true, decision: Object.freeze({ decision: parsed.decision }) };
  return { ok: true, decision: Object.freeze({
    decision: parsed.decision,
    memoryCandidates: parseIsolatedMemoryCandidates(record?.memoryCandidates, context),
  }) };
}

function removeRespondMemoryCandidates(text: string, record: Record<string, unknown> | undefined): string {
  if (record?.action !== "respond" || !Object.hasOwn(record, "memoryCandidates")) return text;
  const { memoryCandidates: _memoryCandidates, ...routing } = record;
  return JSON.stringify({ decision: routing });
}

function parseIsolatedMemoryCandidates(value: unknown, context: ConversationMemoryAuthoringContext | undefined): readonly MemoryCandidate[] {
  try { return parseConversationMemoryCandidates(value, context); }
  catch { return Object.freeze([]); }
}

function readDecisionVariants(format: ModelGatewayJsonSchemaFormat): readonly Record<string, unknown>[] {
  const decision = asRecord(asRecord(format.schema.properties)?.decision);
  if (!decision) throw new Error("supervisor_memory_routing_format_invalid");
  if (!Array.isArray(decision.anyOf)) return [decision];
  return decision.anyOf.map((value) => {
    const variant = asRecord(value);
    if (!variant) throw new Error("supervisor_memory_routing_variant_invalid");
    return variant;
  });
}

function decodeDecision(text: string): Record<string, unknown> | undefined {
  try { return readStructuredDecisionEnvelope(JSON.parse(text)); } catch { return undefined; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
