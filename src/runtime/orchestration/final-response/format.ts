import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { conversationMemoryCandidatesSchema, conversationMemoryPostValidatedSchemaConstraints } from "../../long-term-memory/conversation-authoring/contract.js";

export function createRootAuthoredResponseFormat(
  maxResponseChars?: number,
): ModelGatewayJsonSchemaFormat {
  const finalResponseSchema = Object.freeze({
    type: "string",
    minLength: 1,
    ...(maxResponseChars !== undefined ? { maxLength: maxResponseChars } : {}),
    description: "The complete user-facing response.",
  });
  return Object.freeze({
    type: "json_schema" as const,
    name: "root_authored_response",
    strict: true,
    postValidatedSchemaConstraints: Object.freeze([
      ...conversationMemoryPostValidatedSchemaConstraints,
      ...(maxResponseChars !== undefined
        ? [Object.freeze({ keyword: "maxLength" as const, path: "/properties/finalResponse/maxLength" })]
        : []),
    ]),
    schema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        finalResponse: finalResponseSchema,
        memoryCandidates: conversationMemoryCandidatesSchema,
      }),
      required: Object.freeze(["finalResponse", "memoryCandidates"]),
      additionalProperties: false,
    }),
  });
}
