import { CORE_TOOL_CONTRACTS } from "../core-tool-contracts.js";
import { Buffer } from "node:buffer";
import { AUTOMATION_TOOL_EVENT_PRESENTATION } from "../automations/event-presentation.js";
import { automationDraftPreparationReceipt } from "../automations/draft-operation-refs.js";
import { AutomationDraftReceiptCapacityError, prepareAutomationDraftReceipt } from "../automations/draft-receipt-admission.js";
import type { AutomationDraftPlanAcceptance } from "../../automations/draft-management.js";
import type { ToolModuleDeclaration } from "../../../capabilities/tool-types.js";
import { AUTOMATION_DRAFT_BATCH_LIMITS, AutomationDraftBatchError, AutomationDraftBatchGraphError } from "../../automations/draft-batch.js";
import type { AutomationService } from "../../automations/service.js";
import { AUTOMATION_BUILDER_PAYLOAD_FORMAT } from "./payload-schema.js";
import { compileAutomationCreationRecipe, hasAutomationCreationRecipe } from "./creation-recipe.js";

function requiredText(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`automation_${key}_required`);
  return value.trim();
}

function expectedRevision(params: Record<string, unknown>): number {
  const value = params.expectedRevision;
  const validRevision = Number.isSafeInteger(value) && Number(value) >= 1;
  if (!validRevision) throw new Error("automation_revision_conflict");
  return Number(value);
}

function parsePlanPayload(params: Record<string, unknown>): unknown {
  const payload = params.planJson;
  if (typeof payload !== "string") throw new AutomationDraftBatchError("automation_batch_invalid", "plan");
  const withinByteLimit = Buffer.byteLength(payload, "utf8") <= AUTOMATION_DRAFT_BATCH_LIMITS.bytes;
  if (!withinByteLimit) throw new AutomationDraftBatchError("automation_batch_too_large", "plan");
  try { return JSON.parse(payload); }
  catch { throw new AutomationDraftBatchError("automation_batch_invalid", "plan"); }
}

function requireAcceptedDraftReceipt(output: ReturnType<typeof prepareAutomationDraftReceipt> | undefined) {
  if (!output) throw new Error("automation_draft_plan_acceptance_missing");
  return output;
}

async function execute(service: AutomationService, params: Record<string, unknown>) {
  const action = requiredText(params, "action");
  const plan = parsePlanPayload(params);
  const operation = CORE_TOOL_CONTRACTS.automationBuilder.normalInvocation.operations.find(({ operationId }) => operationId === action);
  if (!operation) throw new Error("automation_action_unknown");
  let acceptedOutput: ReturnType<typeof prepareAutomationDraftReceipt> | undefined;
  const accept: AutomationDraftPlanAcceptance = ({ draft, aliases }) => {
    const receipt = { automationId: draft.automationId, revision: draft.revision,
      rootSequenceId: draft.definition.body.id, aliases,
      draft, ...automationDraftPreparationReceipt(draft.definition) };
    acceptedOutput = prepareAutomationDraftReceipt(receipt, {
      tool: "automation_builder", operation, params, mutationEvidence: true,
    });
    return true;
  };
  if (action === "create_automation_draft") {
    const creationPlan = hasAutomationCreationRecipe(plan) ? compileAutomationCreationRecipe(plan) : plan;
    await service.createDraftPlan(requiredText(params, "title"), creationPlan, accept);
    return requireAcceptedDraftReceipt(acceptedOutput);
  }
  await service.applyDraftPlan(requiredText(params, "automationId"), expectedRevision(params), plan, accept);
  return requireAcceptedDraftReceipt(acceptedOutput);
}

function failureDetails(error: unknown) {
  if (error instanceof AutomationDraftReceiptCapacityError) return error.details;
  if (error instanceof AutomationDraftBatchGraphError)
    return { code: error.code, path: error.path, issues: error.issues, omittedIssueCount: error.omittedIssueCount };
  if (error instanceof AutomationDraftBatchError) return { code: error.code, path: error.path,
    ...(error.commandPath ? { commandPath: error.commandPath } : {}) };
  return { code: error instanceof Error ? error.message : String(error) };
}

/** The builder exposes the canonical draft transaction without runtime execution authority. */
export function createAutomationBuilderToolModule(
  getService: () => AutomationService, ready: () => Promise<void>,
): ToolModuleDeclaration {
  return {
    definition: {
      name: CORE_TOOL_CONTRACTS.automationBuilder.name,
      eventPresentation: {
        ...AUTOMATION_TOOL_EVENT_PRESENTATION,
        metadata: {
          ...AUTOMATION_TOOL_EVENT_PRESENTATION.metadata,
          inputPreview: { param: "planJson", kind: "string", maxLength: 500, preserveWhitespace: true },
          contentLength: { param: "planJson", kind: "length" },
        },
      },
      description: "Build or update a complete connected ABot Studio draft with one atomic canonical plan. Use this for multi-step authoring; automations provides discovery, reads and individual edits. Future workflow actions are data to configure, not actions to perform while authoring. The user retains permission, publication and run control.",
      routingCapability: "semantic_mutation", catalogGroups: ["automations"],
      developmentRoles: ["auxiliary"], controlsRefinement: "mechanical_when_complete",
      payloadChannelSpec: { params: ["planJson"], outputParam: "planJson", generationMode: "raw_text",
        stages: [{ outputParam: "planJson", responseFormat: AUTOMATION_BUILDER_PAYLOAD_FORMAT }] },
    },
    normalInvocation: CORE_TOOL_CONTRACTS.automationBuilder.normalInvocation,
    async implementation(params, context) {
      try {
        await ready();
        context?.abortSignal?.throwIfAborted();
        return await execute(getService(), params);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: JSON.stringify(failureDetails(error)), error: message,
          producedNewInformation: false, data: { mutationEvidence: false } };
      }
    },
  };
}
