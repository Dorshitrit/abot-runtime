import { supportsModelReasoningBudget } from "../../shared/model-reasoning.js";
import type { ToolNormalInvocationInput, ToolNormalInvocationPayload, ToolNormalInvocationOperation } from "../../capabilities/normal-invocation/contracts.js";
import type { ToolNormalInvocationAttachmentInput } from "../../capabilities/normal-invocation/contracts.js";
import type { ToolCatalogGroup } from "../../capabilities/tool-types.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type { OperationRef } from "./definition-contracts.js";
import type { AutomationPersistence } from "./persistence.js";
import { currentAutomationGrant, permitsAutomationOperation } from "./permission-grants.js";

export type AutomationCatalogOperation = Readonly<{
  toolName: string;
  operationId: string;
  contractVersion: number;
  label: string;
  outputChannels?: ToolNormalInvocationOperation["outputChannels"];
  pluginName?: string;
  catalogGroups: readonly ToolCatalogGroup[];
  toolDescription?: string;
  permissionMode: "full_access" | "full_plus";
  effect: "read_only" | "mutating" | "mixed";
  approval: "request_policy" | "always";
  input: ToolNormalInvocationInput;
  fixedParams?: ToolNormalInvocationOperation["fixedParams"];
  payload?: ToolNormalInvocationPayload;
  attachmentInput?: ToolNormalInvocationAttachmentInput;
  selectionControlIds?: readonly string[];
}>;

const EXCLUDED_RUNNING_TOOLS = new Set(["schedules", "automations", "automation_builder"]);

export async function readAutomationCatalog(input: {
  automationId: string;
  environmentId: string;
  config: RuntimeConfig;
  tools: ToolRegistry;
  persistence: AutomationPersistence;
}) {
  const prepared = await input.tools.prepareRequest?.() ?? input.tools;
  const state = await input.persistence.read();
  const grant = currentAutomationGrant(state.grants, input.environmentId, input.automationId);
  const grantableOperations: AutomationCatalogOperation[] = [];
  const operations: AutomationCatalogOperation[] = [];
  for (const registration of prepared.listNormalInvocations?.() ?? []) {
    if (EXCLUDED_RUNNING_TOOLS.has(registration.toolName)) continue;
    const permissionMode = registration.definition.requiredPermissionMode ?? "full_access";
    for (const operation of registration.contract.operations) {
      const entry: AutomationCatalogOperation = {
        toolName: registration.toolName,
        operationId: operation.operationId,
        contractVersion: registration.contract.version,
        label: operation.summary,
        ...(operation.outputChannels ? { outputChannels: operation.outputChannels } : {}),
        ...(registration.definition.pluginName
          ? { pluginName: registration.definition.pluginName }
          : {}),
        catalogGroups: registration.definition.catalogGroups ?? [],
        ...(registration.definition.description
          ? { toolDescription: registration.definition.description }
          : {}),
        permissionMode,
        effect: operation.effect,
        approval: operation.approval,
        input: operation.input,
        ...(operation.fixedParams ? { fixedParams: operation.fixedParams } : {}),
        ...(operation.payload ? { payload: operation.payload } : {}),
        ...(operation.attachmentInput
          ? { attachmentInput: operation.attachmentInput }
          : {}),
        ...(operation.selectionControlIds
          ? { selectionControlIds: operation.selectionControlIds } : {}),
      };
      grantableOperations.push(entry);
      const reference: OperationRef = {
        toolName: entry.toolName,
        operationId: entry.operationId,
        contractVersion: entry.contractVersion,
      };
      if (permitsAutomationOperation(
        grant, input.environmentId, input.automationId, reference, permissionMode,
      )) operations.push(entry);
    }
  }
  const models = Object.entries(input.config.models?.profiles ?? {}).map(([id, profile]) => ({
    id,
    label: profile.label ?? id,
    ...(supportsModelReasoningBudget({ provider: input.config.models?.providers?.[profile.provider ?? ""]?.type ?? "", supportsThinking: profile.supportsThinking }) ? { reasoningControls: { budgetTokens: true } } : {}),
    ...(profile.provider ? { provider: profile.provider } : {}),
  }));
  const latestAgents = new Map<string, (typeof state.savedAgents)[number]>();
  for (const saved of state.savedAgents) {
    const previous = latestAgents.get(saved.agentId);
    if (!previous || saved.revision > previous.revision) latestAgents.set(saved.agentId, saved);
  }
  const savedAgents = [...latestAgents.values()].map((saved) => ({
    id: saved.agentId,
    revision: saved.revision,
    title: saved.agent.title,
    modelProfileId: saved.agent.modelProfileId,
    agent: saved.agent,
  }));
  return { operations, grantableOperations, models, savedAgents };
}
