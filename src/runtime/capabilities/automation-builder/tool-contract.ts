import type { ToolNormalInvocationContract } from "../../../capabilities/tool-types.js";
import { AUTOMATION_DRAFT_BATCH_LIMITS } from "../../automations/draft-batch.js";
import { AUTOMATION_BUILDER_CREATION_INSTRUCTIONS, AUTOMATION_BUILDER_APPLY_SUMMARY, AUTOMATION_BUILDER_CREATE_SUMMARY, AUTOMATION_BUILDER_PAYLOAD_INSTRUCTIONS } from "./payload-instructions.js";

const payload = { kind: "raw_text", param: "planJson", minBytes: 2,
  maxBytes: AUTOMATION_DRAFT_BATCH_LIMITS.bytes, instructions: AUTOMATION_BUILDER_PAYLOAD_INSTRUCTIONS } as const;

export const automationBuilderToolContract = {
  version: 1,
  operations: [
    {
      operationId: "create_automation_draft",
      summary: AUTOMATION_BUILDER_CREATE_SUMMARY,
      effect: "mutating", approval: "request_policy", fixedParams: { action: "create_automation_draft" },
      input: { type: "object", additionalProperties: false,
        properties: { title: { type: "string", minLength: 1, maxLength: 160 } }, required: ["title"] },
      selectionControlIds: ["title"], payload: { ...payload, instructions: AUTOMATION_BUILDER_CREATION_INSTRUCTIONS },
    },
    {
      operationId: "apply_automation_draft_changes",
      summary: AUTOMATION_BUILDER_APPLY_SUMMARY,
      effect: "mutating", approval: "request_policy", fixedParams: { action: "apply_automation_draft_changes" },
      input: { type: "object", additionalProperties: false,
        properties: { automationId: { type: "string", minLength: 1, maxLength: 128 },
          expectedRevision: { type: "integer", minimum: 1, maximum: 2_147_483_647 } },
        required: ["automationId", "expectedRevision"] },
      selectionControlIds: ["automationId", "expectedRevision"], payload,
    },
  ],
} as const satisfies ToolNormalInvocationContract;
