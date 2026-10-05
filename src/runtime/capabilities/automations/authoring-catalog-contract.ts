import type { ToolNormalInvocationOperation } from "../../../capabilities/tool-types.js";
import { AUTOMATION_CATALOG_OPERATION_REF_MAX_LENGTH } from "./authoring-catalog.js";
import { AUTOMATION_AUTHORING_PREPARATION_LIMITS } from "./authoring-preparation-limits.js";

const automationId = { type: "string", minLength: 1, maxLength: 128 } as const;
const operationName = { type: "string", minLength: 1, maxLength: 64 } as const;

export const automationAuthoringCatalogOperations = [
  {
    operationId: "browse_catalog",
    summary: "Discover available tools and models before creating a draft; omit automationId for a new workflow. view=index returns 50 compact refs per page; page with nextOffset only if needed. Select needed operation refs for prepare_draft within its per-read limit; use multiple reads if needed, then create the whole connected draft. Legacy view=operation resolves one exact toolName/operationId/contractVersion. Discovery never runs workflow tools or grants access.",
    effect: "read_only", approval: "request_policy", fixedParams: { action: "browse_catalog" },
    input: { type: "object", additionalProperties: false,
      properties: { automationId, view: { type: "string", enum: ["index", "operation"] },
        offset: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
        toolName: operationName, operationId: operationName,
        contractVersion: { type: "integer", minimum: 1, maximum: 2_147_483_647 } },
      required: ["view"] },
    selectionControlIds: ["view"],
  },
] as const satisfies readonly ToolNormalInvocationOperation[];

export const automationAuthoringPreparationOperation = {
    operationId: "prepare_draft",
    summary: `Prepare a draft or related edit. Select operationRefs needed for this edit from browse_catalog or the full inventory in read_draft/builder receipts (up to ${AUTOMATION_AUTHORING_PREPARATION_LIMITS.operationRefs} per read; [] when no tool schemas are needed). Read separate selections if more are needed, then save one atomic edit. Returns exact schemas, models and the authoring reference. Omit automationId for a new draft. Does not create, run, publish or grant access.`,
    effect: "read_only", approval: "request_policy", fixedParams: { action: "prepare_draft" },
    input: { type: "object", additionalProperties: false,
      properties: { automationId, operationRefs: { type: "array", minItems: 0, maxItems: AUTOMATION_AUTHORING_PREPARATION_LIMITS.operationRefs,
        items: { type: "string", minLength: 1, maxLength: AUTOMATION_CATALOG_OPERATION_REF_MAX_LENGTH } } },
      required: ["operationRefs"] },
    selectionControlIds: ["operationRefs"],
} as const satisfies ToolNormalInvocationOperation;
