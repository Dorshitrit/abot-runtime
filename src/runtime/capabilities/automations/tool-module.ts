import { Buffer } from "node:buffer";
import { AUTOMATION_TOOL_EVENT_PRESENTATION } from "./event-presentation.js";
import type {
  ToolExecutionContext,
  ToolModuleDeclaration,
} from "../../../capabilities/tool-types.js";
import type { AutomationService } from "../../automations/service.js";
import { automationDraftPreparationReceipt } from "./draft-operation-refs.js";
import { AutomationDraftReceiptCapacityError, prepareAutomationDraftReceipt } from "./draft-receipt-admission.js";
import type { AutomationRevision, WorkflowNode } from "../../automations/definition-contracts.js";
import { readAutomationDraftIndex } from "./draft-index.js";
import { automationModelToolContract } from "./model-tool-contract.js";
import { readAutomationAuthoringPreparation } from "./authoring-preparation.js";
import { automationAuthoringCatalogScope, readAutomationAuthoringCatalog, readAutomationAuthoringCatalogIndex } from "./authoring-catalog.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../automation-builder/authoring-reference.js";
import {
  executeAutomationAuthoringInput,
  isAutomationAuthoringInputAction,
} from "./authoring-inputs.js";

function requiredText(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`automation_${key}_required`);
  return value.trim();
}

function requiredInteger(params: Record<string, unknown>, key: string, minimum = 0): number {
  const value = params[key];
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new Error(`automation_${key}_invalid`);
  return Number(value);
}

function jsonFragment(params: Record<string, unknown>, key: string): unknown {
  const source = requiredText(params, key);
  if (Buffer.byteLength(source, "utf8") > 4_096)
    throw new Error("automation_graph_invalid");
  try { return JSON.parse(source); }
  catch { throw new Error("automation_graph_invalid"); }
}

function jsonObject(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = jsonFragment(params, key);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("automation_graph_invalid");
  return value as Record<string, unknown>;
}

function jsonArray(params: Record<string, unknown>, key: string): unknown[] {
  const value = jsonFragment(params, key);
  if (!Array.isArray(value)) throw new Error("automation_graph_invalid");
  return value;
}

function supplied(params: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const patch = Object.fromEntries(keys
    .filter((key) => params[key] !== undefined)
    .map((key) => [key, params[key]]));
  if (Object.keys(patch).length === 0) throw new Error("automation_graph_invalid");
  return patch;
}

function nodeIds(node: WorkflowNode): string[] {
  if (node.kind === "sequence") return [node.id, ...node.children.flatMap(nodeIds)];
  if (node.kind === "parallel") return [node.id, ...node.branches.flatMap(nodeIds)];
  return [node.id];
}

function changedIds(before: AutomationRevision, after: AutomationRevision): string[] {
  const previous = new Set(nodeIds(before.body));
  return nodeIds(after.body).filter((id) => !previous.has(id));
}

async function mutate(
  service: AutomationService,
  params: Record<string, unknown>,
  mutation: unknown,
) {
  const automationId = requiredText(params, "automationId");
  const expectedRevision = requiredInteger(params, "expectedRevision", 1);
  const before = await service.getDraft(automationId);
  if (!before) throw new Error("automation_not_found");
  const next = await service.updateDraft(automationId, expectedRevision, mutation);
  return {
    automationId,
    revision: next.revision,
    newNodeIds: changedIds(before.definition, next.definition),
    ...(next.definition.source ? { sourceId: next.definition.source.sourceId } : {}),
  };
}

async function execute(
  service: AutomationService,
  params: Record<string, unknown>,
): Promise<unknown> {
  const action = requiredText(params, "action");
  if (action === "create_draft") {
    const draft = await service.create(requiredText(params, "title"));
    return { automationId: draft.automationId, revision: draft.revision,
      rootSequenceId: draft.definition.body.id };
  }
  if (action === "list_drafts")
    return readAutomationDraftIndex(service, params.offset === undefined
      ? 0 : params.offset);
  if (action === "browse_catalog") return readAutomationAuthoringCatalog(service, params);
  if (action === "prepare_draft") return readAutomationAuthoringPreparation(service, params);
  const automationId = requiredText(params, "automationId");
  if (isAutomationAuthoringInputAction(action)) return executeAutomationAuthoringInput(service, params);
  if (action === "read_draft") {
    const draft = await service.getDraft(automationId);
    if (!draft) throw new Error("automation_not_found");
    return { draft, ...automationDraftPreparationReceipt(draft.definition) };
  }
  const isCatalogIndexRequest = action === "catalog" && params.projection === "index";
  if (isCatalogIndexRequest) return readAutomationAuthoringCatalogIndex(service, automationId, 0);
  const hasUnsupportedCatalogProjection = action === "catalog" && params.projection !== undefined;
  if (hasUnsupportedCatalogProjection) throw new Error("automation_catalog_projection_invalid");
  if (action === "catalog") {
    const catalog = await service.catalog(automationId);
    return { kind: "automation_authoring_catalog_v1", grantsPermissions: false,
      catalogScope: automationAuthoringCatalogScope(automationId),
      permissions: AUTOMATION_AUTHORING_REFERENCE.permissions,
      operations: catalog.grantableOperations.map(({ fixedParams: _fixedParams, ...operation }) => operation),
      grantedOperations: catalog.operations.map(({ toolName, operationId, contractVersion }) =>
        ({ toolName, operationId, contractVersion })),
      models: catalog.models,
      savedAgents: catalog.savedAgents.map((agent) => ({
        agentId: agent.id, revision: agent.revision, title: agent.title,
        modelProfileId: agent.modelProfileId,
      })) };
  }
  if (action === "validate_draft") return { issues: await service.validate(automationId) };
  if (action === "save_agent") {
    const saved = await service.saveAgentFromDraft({
      automationId,
      nodeId: requiredText(params, "nodeId"),
      expectedDraftRevision: requiredInteger(params, "expectedRevision", 1),
      ...(params.agentId !== undefined ? { agentId: requiredText(params, "agentId") } : {}),
      ...(params.expectedAgentRevision !== undefined
        ? { expectedAgentRevision: requiredInteger(params, "expectedAgentRevision", 1) }
        : {}),
    });
    return { agentId: saved.agentId, revision: saved.revision, title: saved.agent.title };
  }

  if (action === "set_details") {
    const patch = supplied(params, ["title", "objective", "workingDirectory"]);
    if (patch.workingDirectory === "") patch.workingDirectory = null;
    return mutate(service, params, { kind: "update_definition", patch });
  }
  if (action === "set_trigger_manual")
    return mutate(service, params, { kind: "update_definition", patch: { trigger: { kind: "manual" } } });
  if (action === "set_trigger_schedule")
    return mutate(service, params, { kind: "update_definition", patch: {
      trigger: { kind: "schedule", schedule: jsonObject(params, "scheduleJson") },
    } });
  if (action === "set_trigger_folder")
    return mutate(service, params, { kind: "update_definition", patch: {
      trigger: { kind: "folder",
        checkEveryMs: requiredInteger(params, "checkEveryMs", 1),
        minimumEligibleFiles: requiredInteger(params, "minimumEligibleFiles", 1) },
    } });
  if (action === "set_folder_source") {
    const draft = await service.getDraft(automationId);
    if (!draft) throw new Error("automation_not_found");
    return mutate(service, params, { kind: "update_definition", patch: {
      source: {
        sourceId: draft.definition.source?.sourceId ?? "",
        location: { kind: "runtime_path", path: requiredText(params, "path") },
        mode: requiredText(params, "mode"),
        recursive: params.recursive,
        includeExisting: params.includeExisting,
        maxBatchFiles: requiredInteger(params, "maxBatchFiles", 1),
        includePatterns: params.includePatterns ?? [],
        excludePatterns: params.excludePatterns ?? [],
      },
    } });
  }
  if (action === "remove_folder_source")
    return mutate(service, params, { kind: "update_definition", patch: { source: null } });
  if (action === "set_run_inputs")
    return mutate(service, params, { kind: "update_definition", patch: { inputs: jsonObject(params, "inputsJson") } });
  if (action === "set_limits") {
    const draft = await service.getDraft(automationId);
    if (!draft) throw new Error("automation_not_found");
    const patch = supplied(params, ["maxConcurrentNodes", "maxModelCallsPerRun",
      "maxToolCallsPerRun", "maxRunDurationMs", "maxRunsPerDay",
      "maxStoredArtifactBytes", "stopReportDeadlineMs"]);
    return mutate(service, params, { kind: "update_definition", patch: {
      limits: { ...draft.definition.limits, ...patch },
    } });
  }

  if (action === "add_agent")
    return mutate(service, params, { kind: "add_node",
      parentSequenceId: requiredText(params, "parentSequenceId"),
      index: requiredInteger(params, "index"), nodeWithoutId: {
        kind: "agent", title: params.title, onFailure: params.onFailure,
        modelProfileId: params.modelProfileId, agentMode: params.agentMode,
        roleInstructions: params.roleInstructions, prompt: params.prompt,
        inputs: {}, tools: [], result: { kind: "text" },
      } });
  if (action === "add_saved_agent") {
    const agentId = requiredText(params, "agentId");
    const agentRevision = requiredInteger(params, "agentRevision", 1);
    const saved = await service.getSavedAgent(agentId, agentRevision);
    if (!saved) throw new Error("automation_saved_agent_not_found");
    const { id: _id, ...configuration } = saved.agent;
    return mutate(service, params, { kind: "add_node",
      parentSequenceId: requiredText(params, "parentSequenceId"),
      index: requiredInteger(params, "index"), nodeWithoutId: {
        ...configuration, savedAgentOrigin: { agentId, revision: agentRevision },
      } });
  }
  if (action === "add_tool")
    return mutate(service, params, { kind: "add_node",
      parentSequenceId: requiredText(params, "parentSequenceId"),
      index: requiredInteger(params, "index"), nodeWithoutId: {
        kind: "tool", title: params.title, onFailure: params.onFailure,
        operation: { toolName: params.toolName, operationId: params.operationId,
          contractVersion: params.contractVersion }, controls: {},
      } });

  const nodeId = requiredText(params, "nodeId");
  if (action === "edit_agent") return mutate(service, params, { kind: "update_node", nodeId,
    patch: supplied(params, ["modelProfileId", "agentMode", "roleInstructions", "prompt"]) });
  if (action === "set_step_policy") return mutate(service, params, { kind: "update_node", nodeId,
    patch: supplied(params, ["title", "onFailure"]) });
  if (action === "set_agent_inputs") return mutate(service, params, { kind: "update_node", nodeId,
    patch: { inputs: jsonObject(params, "bindingsJson") } });
  if (action === "set_agent_tools") return mutate(service, params, { kind: "update_node", nodeId,
    patch: { tools: jsonArray(params, "toolsJson") } });
  if (action === "set_agent_result") return mutate(service, params, { kind: "update_node", nodeId,
    patch: { result: jsonObject(params, "resultJson") } });
  if (action === "set_agent_acceptance") return mutate(service, params, { kind: "update_node", nodeId,
    patch: { acceptance: jsonArray(params, "acceptanceJson") } });
  if (action === "set_tool_controls") return mutate(service, params, { kind: "update_node", nodeId,
    patch: { controls: jsonObject(params, "bindingsJson") } });
  if (action === "set_tool_payload") return mutate(service, params, { kind: "update_node", nodeId,
    patch: { payload: jsonObject(params, "payloadJson") } });
  if (action === "remove_step") return mutate(service, params, { kind: "remove_node", nodeId });
  if (action === "move_step") return mutate(service, params, { kind: "move_node", nodeId,
    parentSequenceId: requiredText(params, "parentSequenceId"),
    index: requiredInteger(params, "index") });
  if (action === "parallel_steps") {
    if (!Array.isArray(params.nodeIds) || !params.nodeIds.every((id) => typeof id === "string"))
      throw new Error("automation_graph_invalid");
    return mutate(service, params, { kind: "wrap_parallel", nodeIds: params.nodeIds });
  }
  throw new Error("automation_action_unknown");
}

/** The caller injects the single environment service after tool registry construction. */
export function createAutomationDraftToolModule(
  getService: () => AutomationService,
  ready: () => Promise<void>,
): ToolModuleDeclaration {
  return {
    definition: {
      name: "automations",
      eventPresentation: AUTOMATION_TOOL_EVENT_PRESENTATION,
      description: "Inspect and make targeted edits to ABot Studio drafts. For a complete connected workflow or several related edits, prefer automation_builder create_automation_draft or apply_automation_draft_changes. Catalog discovery lists tools for the FUTURE workflow, not Studio editing commands; fetch operation detail only when needed. Successful edits return exact revision and newNodeIds for reuse; read_draft when state is unknown or after a revision conflict. Draft authoring only: the user grants permissions, publishes and runs automations.",
      routingCapability: "semantic_mutation",
      catalogGroups: ["automations"],
      developmentRoles: ["auxiliary"],
      controlsRefinement: "mechanical_when_complete",
    },
    normalInvocation: automationModelToolContract,
    async implementation(params, context?: ToolExecutionContext) {
      try {
        await ready();
        context?.abortSignal?.throwIfAborted();
        const result = await execute(getService(), params);
        if (params.action === "read_draft") {
          const operation = automationModelToolContract.operations.find(({ operationId }) => operationId === "read_draft")!;
          return prepareAutomationDraftReceipt(result, { tool: "automations", operation, params, mutationEvidence: false });
        }
        const isDraftMutation = !["list_drafts", "read_draft", "catalog", "browse_catalog", "prepare_draft", "validate_draft"].includes(String(params.action));
        return { ok: true, output: JSON.stringify(result), producedNewInformation: true,
          data: { mutationEvidence: isDraftMutation, currentStateEvidence: true } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const output = error instanceof AutomationDraftReceiptCapacityError ? JSON.stringify(error.details) : message;
        return { ok: false, output, error: message, producedNewInformation: false };
      }
    },
  };
}
