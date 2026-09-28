import type {
  StructuredModelParseResult,
  StructuredModelValidationIssue,
} from "../../model/invoke-structured-step.js";
import type {
  RootAuthoredResponse,
} from "../../long-term-memory/contracts.js";
import { parseConversationMemoryCandidates } from "../../long-term-memory/conversation-authoring/contract.js";
import type { ConversationMemoryAuthoringContext } from "../../long-term-memory/conversation-authoring/context.js";
import { CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS } from "../../long-term-memory/conversation-authoring/prompt.js";

export type RootFinalResponseValidator = (
  finalResponse: string,
) => readonly StructuredModelValidationIssue[];

export { MAX_CONVERSATION_MEMORY_CANDIDATES as MAX_ROOT_MEMORY_CANDIDATES } from "../../long-term-memory/conversation-authoring/contract.js";

export function parseRootAuthoredResponse(
  text: string,
  options: Readonly<{
    maxResponseChars?: number;
    validateFinalResponse?: RootFinalResponseValidator;
    memoryAuthoringContext?: ConversationMemoryAuthoringContext;
  }> = {},
): StructuredModelParseResult<RootAuthoredResponse> {
  const envelope = decodeEnvelope(text);
  if (!envelope) {
    return invalidResponse("root_authored_response_json_invalid");
  }
  if (typeof envelope.finalResponse !== "string") {
    return invalidResponse("root_authored_response_final_missing");
  }
  const finalResponse = envelope.finalResponse;
  if (!finalResponse.trim()) {
    return invalidResponse("root_authored_response_final_empty");
  }
  if (
    options.maxResponseChars !== undefined &&
    finalResponse.length > options.maxResponseChars
  ) {
    return invalidResponse(
      "root_authored_response_final_too_long",
      `Return the complete finalResponse within ${options.maxResponseChars} characters.`,
    );
  }
  const roleIssues = options.validateFinalResponse?.(finalResponse) ?? [];
  if (roleIssues.length > 0) {
    return Object.freeze({
      ok: false as const,
      stage: "root_authored_response",
      issues: Object.freeze([...roleIssues]),
    });
  }
  return Object.freeze({
    ok: true as const,
    decision: Object.freeze({
      finalResponse,
      memoryCandidates: parseConversationMemoryCandidates(envelope.memoryCandidates, options.memoryAuthoringContext),
    }),
  });
}

export function createPlainRootAuthoredResponse(
  finalResponse: string,
): RootAuthoredResponse {
  return Object.freeze({
    finalResponse,
    memoryCandidates: Object.freeze([]),
  });
}

export function buildMemoryAuthoringInstructions(): readonly string[] {
  return Object.freeze([
    "Return exactly one structured response matching the supplied schema. finalResponse is the complete user-facing answer and must remain fully useful on its own. memoryCandidates is an array and must be empty when there is nothing durable to propose.",
    ...CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS,
  ]);
}

function decodeEnvelope(text: string): Record<string, unknown> | undefined {
  try {
    return readObject(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function invalidResponse(
  code: string,
  message = "Return one structured response with a complete non-empty finalResponse.",
): StructuredModelParseResult<RootAuthoredResponse> {
  return Object.freeze({
    ok: false as const,
    stage: "root_authored_response",
    issues: Object.freeze([
      Object.freeze({ code, path: "finalResponse", message }),
    ]),
  });
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
