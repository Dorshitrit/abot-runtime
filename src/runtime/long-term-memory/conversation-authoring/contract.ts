import type { MemoryCandidate } from "../contracts.js";
import type { ConversationMemoryAuthoringContext } from "./context.js";

export const MAX_CONVERSATION_MEMORY_CANDIDATES = 8;
const MAX_EXPLICIT_REQUEST_QUOTE_CHARACTERS = 1000;

// The shared decoder enforces this bound after local-provider generation.
export const conversationMemoryPostValidatedSchemaConstraints = Object.freeze([
  Object.freeze({
    keyword: "maxLength" as const,
    path: "/properties/memoryCandidates/items/properties/reason/maxLength",
  }),
  Object.freeze({
    keyword: "maxLength" as const,
    path: "/properties/memoryCandidates/items/properties/explicitRequestQuote/maxLength",
  }),
]);

export const conversationMemoryCandidatesSchema = Object.freeze({
  type: "array", maxItems: MAX_CONVERSATION_MEMORY_CANDIDATES,
  description: "Optional assessed proposals for durable user knowledge; empty is normal.",
  items: Object.freeze({
    type: "object",
    properties: Object.freeze({
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      target: { type: ["string", "null"], description: "Supplied mutable ref to update, or null for a new candidate." },
      score: { type: "integer", minimum: 0, maximum: 100 },
      reason: { type: "string", minLength: 1, maxLength: 1000 },
      reinforced: { type: "boolean" },
      explicitRequestQuote: { type: ["string", "null"], maxLength: MAX_EXPLICIT_REQUEST_QUOTE_CHARACTERS },
    }),
    required: ["content", "tags", "target", "score", "reason", "reinforced", "explicitRequestQuote"],
    additionalProperties: false,
  }),
});

/** Both root contracts use this decoder; provenance and exact versions stay server-owned. */
export function parseConversationMemoryCandidates(
  value: unknown,
  context?: ConversationMemoryAuthoringContext,
): readonly MemoryCandidate[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const candidates: MemoryCandidate[] = [];
  for (const entry of value) {
    if (candidates.length >= MAX_CONVERSATION_MEMORY_CANDIDATES) break;
    const candidate = parseConversationMemoryCandidate(entry, context);
    if (candidate) candidates.push(candidate);
  }
  return Object.freeze(candidates);
}

function parseConversationMemoryCandidate(value: unknown, context: ConversationMemoryAuthoringContext | undefined): MemoryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.content !== "string") return undefined;
  const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const candidate = { content: record.content, tags: Object.freeze(tags) };
  // Compatibility callers without a knowledge service cannot mint assessed evidence.
  if (!context) return Object.freeze(candidate);
  if (!hasConversationAssessment(record)) return undefined;
  const explicitlyRequested = isBoundExplicitRequest(record.explicitRequestQuote, context.userMessages);
  if (record.explicitRequestQuote !== null && record.explicitRequestQuote !== undefined && !explicitlyRequested) return undefined;
  const target = typeof record.target === "string" ? context.targets.get(record.target) : undefined;
  if (record.target !== null && !target?.mutable) return undefined;
  return Object.freeze({ ...candidate, assessment: Object.freeze({
    score: record.score, reason: record.reason.trim(), reinforced: record.reinforced,
    ...(explicitlyRequested ? { explicitlyRequested: true } : {}),
    evidence: context.evidence, ...(target ? { target } : {}),
  }) });
}

function isBoundExplicitRequest(quote: unknown, userMessages: readonly string[]): boolean {
  if (typeof quote !== "string" || !quote.trim() || quote.length > MAX_EXPLICIT_REQUEST_QUOTE_CHARACTERS) return false;
  return userMessages.some((message) => message.includes(quote));
}

function hasConversationAssessment(record: Record<string, unknown>): record is Record<string, unknown> & { score: number; reason: string; reinforced: boolean } {
  if (typeof record.score !== "number" || !Number.isInteger(record.score)) return false;
  if (record.score < 0 || record.score > 100) return false;
  if (typeof record.reason !== "string" || !record.reason.trim() || record.reason.length > 1000) return false;
  if (typeof record.reinforced !== "boolean") return false;
  return record.target === null || typeof record.target === "string";
}
