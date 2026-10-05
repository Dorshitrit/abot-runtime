import type { ToolNormalInvocationContract, ToolNormalInvocationOperation } from "../../../capabilities/tool-types.js";
import { automationDraftToolContract } from "./tool-contract.js";
import { automationAuthoringPreparationOperation } from "./authoring-catalog-contract.js";
import { AUTOMATION_AUTHORING_PREPARATION_LIMITS } from "./authoring-preparation-limits.js";

function authoringOperation(operationId: string): ToolNormalInvocationOperation {
  const operation = [...automationDraftToolContract.operations, automationAuthoringPreparationOperation]
    .find((candidate) => candidate.operationId === operationId);
  if (!operation) throw new Error(`automation_authoring_contract_missing:${operationId}`);
  return { ...operation, selectionControlIds: operation.input.required };
}

/** These reads need complete selected inputs, not another model call to fill optional controls. */
function completeAuthoringRead(operationId: string, fields: readonly string[]): ToolNormalInvocationOperation {
  const operation = authoringOperation(operationId);
  return { ...operation, input: { ...operation.input,
    properties: Object.fromEntries(fields.map((field) => [field, operation.input.properties[field]!])),
    required: fields }, selectionControlIds: fields };
}

const catalogIndex = completeAuthoringRead("browse_catalog", ["offset"]);

/** The model writes connected graphs through automation_builder; direct legacy actions stay supported. */
export const automationModelToolContract: ToolNormalInvocationContract = {
  version: automationDraftToolContract.version,
  operations: [
    { ...catalogIndex, fixedParams: { ...catalogIndex.fixedParams, view: "index" },
      summary: "Discover available workflow tools, models and saved agents without creating a draft. Start at offset 0; use nextOffset only if more references are needed. Select needed operation refs for prepare_draft within its per-read limit; use multiple reads if needed, then save the entire connected workflow with create_automation_draft. This reads configuration only; it does not run future steps or grant access." },
    { ...completeAuthoringRead("prepare_draft", ["operationRefs"]),
      summary: `Prepare authoring from selected operationRefs needed for this edit. Copy from browse_catalog or the full inventory in read_draft/builder receipts (up to ${AUTOMATION_AUTHORING_PREPARATION_LIMITS.operationRefs} per read; [] when no tool schemas are needed). Existing refs need no rediscovery; read separate selections if more are needed. Returns schemas, models and the authoring reference. Then save one atomic create_automation_draft or apply_automation_draft_changes. Creates no draft and runs no workflow steps.` },
    completeAuthoringRead("list_drafts", ["offset"]),
    authoringOperation("read_draft"),
    authoringOperation("validate_draft"),
    { ...authoringOperation("add_saved_agent"),
      summary: "Reuse an exact saved-agent revision in an existing draft. For a NEW workflow made solely from saved agents, first use create_automation_draft with a definition-only plan, then insert saved revisions using its returned IDs and revision. Never invent a placeholder step. Reusing a saved agent does not inherit an automation permission grant." },
    authoringOperation("save_agent"),
  ],
};
