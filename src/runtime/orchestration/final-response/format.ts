import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { MAX_ROOT_MEMORY_CANDIDATES } from "./authoring-contract.js";

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
    ...(maxResponseChars !== undefined
      ? {
          postValidatedSchemaConstraints: Object.freeze([
            Object.freeze({
              keyword: "maxLength" as const,
              path: "/properties/finalResponse/maxLength",
            }),
          ]),
        }
      : {}),
    schema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        finalResponse: finalResponseSchema,
        memoryCandidates: Object.freeze({
          type: "array",
          maxItems: MAX_ROOT_MEMORY_CANDIDATES,
          description:
            "Optional durable facts or preferences proposed for core policy review.",
          items: Object.freeze({
            type: "object",
            properties: Object.freeze({
              content: Object.freeze({ type: "string" }),
              tags: Object.freeze({
                type: "array",
                items: Object.freeze({ type: "string" }),
              }),
            }),
            required: Object.freeze(["content", "tags"]),
            additionalProperties: false,
          }),
        }),
      }),
      required: Object.freeze(["finalResponse", "memoryCandidates"]),
      additionalProperties: false,
    }),
  });
}
