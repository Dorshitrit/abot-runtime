import type {
  ExecutionAgentDecisionContractOptions,
  ExecutionAgentDecisionValidationIssue,
} from "./contracts.js";
import type { MemoryCandidate } from "../../long-term-memory/contracts.js";
import {
  conversationMemoryCandidatesSchema,
  parseConversationMemoryCandidates,
} from "../../long-term-memory/conversation-authoring/contract.js";
import { issue } from "./decision-validation.js";

/** A short-answer option, not a conversion from characters to model tokens. */
export const EXECUTION_AGENT_DIRECT_RESPONSE_MAX_LENGTH = 1_024;

export function directResponseVariants(
  maxLength: number | undefined,
  presentation: Record<string, unknown>,
  memoryAuthoring = false,
): Record<string, unknown>[] {
  if (!isDirectResponseLimit(maxLength)) return [];
  return [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["respond"] },
        response: { type: "string", minLength: 1, maxLength },
        ...(memoryAuthoring
          ? { memoryCandidates: conversationMemoryCandidatesSchema }
          : {}),
        ...presentation,
      },
      required: [
        "action", "response",
        ...(memoryAuthoring ? ["memoryCandidates"] : []),
        ...Object.keys(presentation),
      ],
    },
  ];
}

export function parseDirectResponse(
  record: Record<string, unknown>,
  maxLength: number | undefined,
  issues: ExecutionAgentDecisionValidationIssue[],
): string | undefined {
  if (!Object.hasOwn(record, "response")) return undefined;
  if (!isDirectResponseLimit(maxLength)) {
    issues.push(
      issue(
        "execution_agent_direct_response_unavailable",
        "decision.response",
        "This request requires the separate response authoring step.",
      ),
    );
    return undefined;
  }
  const response = record.response;
  if (typeof response !== "string" || response.trim().length === 0) {
    issues.push(
      issue(
        "execution_agent_direct_response_invalid",
        "decision.response",
        "A direct response must contain the complete non-empty answer.",
      ),
    );
    return undefined;
  }
  if (response.length > maxLength) {
    issues.push(
      issue(
        "execution_agent_direct_response_too_long",
        "decision.response",
        `A direct response must fit ${maxLength} characters. Choose respond without response for a longer complete answer; do not shorten or truncate it.`,
      ),
    );
    return undefined;
  }
  return response;
}

export function parseDirectResponseMemoryCandidates(
  record: Record<string, unknown>,
  authoring: ExecutionAgentDecisionContractOptions["directResponseMemoryAuthoring"],
): readonly MemoryCandidate[] | undefined {
  if (!authoring) return undefined;
  return parseConversationMemoryCandidates(
    record.memoryCandidates, authoring.context,
  );
}

function isDirectResponseLimit(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= EXECUTION_AGENT_DIRECT_RESPONSE_MAX_LENGTH
  );
}
