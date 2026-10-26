import type { ToolNormalInvocationContract } from "../../../capabilities/tool-types.js";
import { BASKET_LIMITS } from "../../information-basket/limits.js";

export const informationBasketToolContract = {
  version: 1,
  operations: [
    {
      operationId: "list_information_sources",
      summary: "List READY source metadata; paginate with nextCursor.",
      effect: "read_only", approval: "request_policy", fixedParams: { action: "list_information_sources" },
      input: { type: "object", additionalProperties: false,
        properties: { cursor: { type: "string", minLength: 1, maxLength: 80 } }, required: [] },
    },
    {
      operationId: "search_information_sources",
      summary: "Search indexed content for candidate sources; matches are not source evidence.",
      effect: "read_only", approval: "request_policy", fixedParams: { action: "search_information_sources" },
      input: { type: "object", additionalProperties: false,
        properties: { query: { type: "string", minLength: 1, maxLength: BASKET_LIMITS.maxQueryCharacters } },
        required: ["query"] },
      selectionControlIds: ["query"],
    },
    {
      operationId: "read_information_source",
      summary: "Read a bounded source window by exact sourceId and expectedRevision; paginate with nextStartChar.",
      effect: "read_only", approval: "request_policy", fixedParams: { action: "read_information_source" },
      input: { type: "object", additionalProperties: false,
        properties: {
          sourceId: { type: "string", minLength: 1, maxLength: 80 },
          expectedRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          startChar: { type: "integer", minimum: 0, maximum: BASKET_LIMITS.maxTextCharacters },
          maxChars: { type: "integer", minimum: 1, maximum: BASKET_LIMITS.maxReadCharacters },
        }, required: ["sourceId", "expectedRevision"] },
      selectionControlIds: ["sourceId", "expectedRevision"],
    },
  ],
} as const satisfies ToolNormalInvocationContract;
