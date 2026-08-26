import type { ModelGatewayJsonSchemaFormat } from "../../../../model-gateway/types.js";
import { SESSION_MEMORY_SUMMARY_MAX_CHARACTERS } from "../../../../sessions/memory/contracts.js";

export function createSessionMemoryCompactionFormat(): ModelGatewayJsonSchemaFormat {
  return Object.freeze({
    type: "json_schema" as const,
    name: "session_memory_compaction",
    strict: true,
    postValidatedSchemaConstraints: Object.freeze([
      Object.freeze({
        keyword: "maxLength" as const,
        path: "/properties/summary/maxLength",
      }),
    ]),
    schema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        summary: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: SESSION_MEMORY_SUMMARY_MAX_CHARACTERS,
        }),
      }),
      required: Object.freeze(["summary"]),
      additionalProperties: false,
    }),
  });
}
