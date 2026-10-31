import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import {
  USER_INTERACTION_TEXT_MAX_LENGTH,
  type UserInteractionProposal,
} from "../../user-interactions/contracts.js";
import type {
  ExecutionAgentDecisionContractOptions,
  ExecutionAgentDecisionParseResult,
} from "./contracts.js";

const INTERACTION_ACTIONS = new Set([
  "open_capability_scope", "extend_capability_scope", "recall_memory",
  "invoke_capability", "invoke_capabilities", "invoke_planner", "invoke_auditor",
]);

function canAttachExecutionInteraction(action: unknown): boolean {
  return typeof action === "string" && INTERACTION_ACTIONS.has(action);
}

/** One nullable property keeps native strict schemas bounded without more variants. */
export function addExecutionInteractionSchemas(
  variants: readonly Record<string, unknown>[],
  enabled: boolean,
): readonly Record<string, unknown>[] {
  if (!enabled) return variants;
  return variants.map((variant) => {
    const properties = variant.properties as Record<string, unknown>;
    const action = properties.action as { enum: readonly unknown[] };
    if (!canAttachExecutionInteraction(action.enum[0])) return variant;
    return {
      ...variant,
      properties: {
        ...properties,
        interaction: {
          anyOf: [
            { type: "null" },
            {
              type: "object", additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["message"] },
                text: {
                  type: "string", minLength: 1,
                  maxLength: USER_INTERACTION_TEXT_MAX_LENGTH,
                },
              },
              required: ["kind", "text"],
            },
          ],
        },
      },
      required: [...(variant.required as readonly string[]), "interaction"],
    };
  });
}

export function parseDecisionWithInteraction(
  text: string,
  options: ExecutionAgentDecisionContractOptions,
  parseAction: (
    text: string,
    options: ExecutionAgentDecisionContractOptions,
  ) => ExecutionAgentDecisionParseResult,
): ExecutionAgentDecisionParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim());
  } catch {
    return parseAction(text, options);
  }
  const record = readStructuredDecisionEnvelope(decoded);
  if (!record || !Object.hasOwn(record, "interaction"))
    return parseAction(text, options);
  if (options.allowUserInteraction !== true)
    return rejectInteraction("User interactions are unavailable for this decision.");
  if (!canAttachExecutionInteraction(record.action))
    return rejectInteraction("Only a nonterminal execution action may include interaction.");
  const interaction = record.interaction === null
    ? undefined
    : parseMessageProposal(record.interaction);
  if (record.interaction !== null && !interaction)
    return rejectInteraction("interaction must be null or one bounded message with kind and text.");
  const { interaction: _proposal, ...action } = record;
  const parsed = parseAction(JSON.stringify({ decision: action }), options);
  if (!parsed.ok) return parsed;
  if (!interaction) return parsed;
  return {
    ok: true,
    decision: Object.freeze({ ...parsed.decision, interaction }),
  };
}

function parseMessageProposal(value: unknown): UserInteractionProposal | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return undefined;
  if (record.kind !== "message") return undefined;
  if (typeof record.text !== "string") return undefined;
  if (!record.text.trim()) return undefined;
  if (record.text.length > USER_INTERACTION_TEXT_MAX_LENGTH) return undefined;
  return Object.freeze({ kind: "message", text: record.text });
}

function rejectInteraction(message: string): ExecutionAgentDecisionParseResult {
  return {
    ok: false, stage: "domain_parser",
    issues: [{
      code: "execution_agent_interaction_invalid",
      path: "decision.interaction", message,
    }],
  };
}
