import { knowledgeSkillWriteOperations } from "./write-contract.js";
import { KNOWLEDGE_SKILL_READ_REFERENCE_MAX_LENGTH } from "./read-targets.js";
import type { ToolNormalInvocationContract } from "../../../capabilities/tool-types.js";
import { KNOWLEDGE_SKILL_READ_MAX_ITEMS } from "../../knowledge-skills/store.js";

export const knowledgeSkillsToolContract = {
  version: 1,
  operations: [
    {
      operationId: "list_skills",
      summary: "Discover reusable procedural documents when guidance could help the current task. Returns only Skill IDs, names and descriptions. Read a selected document with read_skill when needed; listing does not read its content or require further action.",
      effect: "read_only",
      approval: "request_policy",
      fixedParams: { action: "list_skills" },
      input: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
    },
    {
      operationId: "read_skill",
      summary: "Read using skillId as an exact ID or full, case-sensitive name. Known references need no LIST; shortened names do not match. IDs win over names. Returns one document, or {skills:[...]} for a shared name, with canonical IDs. All name matches are returned, up to eight; more fails. Guidance applies only within the current request and permissions. Tool contracts still govern execution; reading neither executes work nor grants authority.",
      effect: "read_only",
      approval: "request_policy",
      fixedParams: { action: "read_skill" },
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          skillId: {
            type: "string",
            minLength: 1,
            maxLength: KNOWLEDGE_SKILL_READ_REFERENCE_MAX_LENGTH,
          },
        },
        required: ["skillId"],
      },
      selectionControlIds: ["skillId"],
    },
    {
      operationId: "read_skills",
      summary: "Read up to eight references in skillIds: exact IDs or full, case-sensitive names. Known references need no LIST or batch; shortened names do not match. IDs win over names; each name expands to all matches. Returns distinct documents in reference order, with name matches in catalog order. Unknown references or more than eight documents fail the whole call. Guidance adds no work, permissions or authority; tool contracts still govern execution.",
      effect: "read_only",
      approval: "request_policy",
      fixedParams: { action: "read_skills" },
      input: {
        type: "object", additionalProperties: false,
        properties: {
          skillIds: { type: "array", minItems: 1, maxItems: KNOWLEDGE_SKILL_READ_MAX_ITEMS,
            items: { type: "string", minLength: 1, maxLength: KNOWLEDGE_SKILL_READ_REFERENCE_MAX_LENGTH } },
        },
        required: ["skillIds"],
      },
      selectionControlIds: ["skillIds"],
    },
    ...knowledgeSkillWriteOperations,
  ],
} as const satisfies ToolNormalInvocationContract;
