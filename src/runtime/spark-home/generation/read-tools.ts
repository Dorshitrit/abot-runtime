import { randomUUID } from "node:crypto";
import type { RegisteredToolNormalInvocation, ToolNormalInvocationOperation } from "../../../capabilities/tool-types.js";
import type { ToolApprovalController, ToolPermissionMode, ToolRegistry } from "../../ports.js";
import type { RuntimeModelPluginConfig } from "../../config/model-plugin-config.js";
import { restrictToolRegistryToRequestMode } from "../../capabilities/request-permission-tool-registry.js";
import { RequestToolResources } from "../../capabilities/request-tool-resources.js";
import { createRegisteredToolNormalInvocationExecutor } from "../../adapters/registered-tool-normal-invocations/executor.js";
import type { SparkHomeAuthoringContext } from "../authoring-context/index.js";
import { homeGenerationFailure, type SparkHomeReadDescriptor, type SparkHomeReadSelection } from "./contracts.js";
import { projectSparkHomeEvidence } from "./read-evidence.js";
import { createSparkHomeResourceReadBudget, isSparkHomeResourceRead, SPARK_HOME_RESOURCE_READ_OPERATION } from "./resource-read-budget.js";

function isHomeResearchOperation(registration: RegisteredToolNormalInvocation, operation: ToolNormalInvocationOperation): boolean {
  if (operation.effect !== "read_only") return false;
  if (operation.payload || operation.attachmentInput) return false;
  if (registration.toolName === "information_basket")
    return ["list_information_sources", "search_information_sources", "read_information_source"].includes(operation.operationId);
  if (registration.toolName === "system_probe") return operation.operationId === "inspect_system_state";
  return registration.definition.catalogGroups?.includes("web") === true;
}

export async function createSparkHomeReadTools(input: {
  registry: ToolRegistry; runId: string; signal: AbortSignal; mode: ToolPermissionMode;
  modelPlugins?: RuntimeModelPluginConfig; sessionId?: string; approvals: ToolApprovalController;
}) {
  const resources = new RequestToolResources();
  try {
    input.signal.throwIfAborted();
    const prepared = await input.registry.prepareRequest?.({ requestState: resources.state, onRequestDispose: resources.onRequestDispose }) ?? input.registry;
    input.signal.throwIfAborted();
    const registry = restrictToolRegistryToRequestMode(prepared, input.mode, input.modelPlugins);
    const registrations = (registry.listNormalInvocations?.() ?? []).flatMap(registration => {
      const operations = registration.contract.operations.filter(operation => isHomeResearchOperation(registration, operation));
      return operations.length ? [{ ...registration, contract: { ...registration.contract, operations } }] : [];
    });
    const executor = createRegisteredToolNormalInvocationExecutor({ registrations, toolResources: resources,
      toolRegistry: { execute(call, options) {
        return registry.execute(call, { ...options, onUnderlyingSettlement(settled) {
          resources.work.trackUntil(settled.then(() => undefined));
        } });
      } },
      requestId: input.runId, abortSignal: input.signal, toolPermissionMode: input.mode,
      toolApprovalController: input.approvals, nextApprovalId: randomUUID,
      sharedState: registry.prepareSharedState?.({ ...(input.sessionId ? { currentSessionId: input.sessionId } : {}),
        requestContext: { agentMode: "reasoning", toolPermissionMode: input.mode } }),
      effectPersistence: {
        async beforeEffect(effect) {
          if (effect.effect !== "read_only") return homeGenerationFailure("spark_home_read_effect_invalid");
          const owner = registrations.find(registration => registration.toolName === effect.target.toolName);
          if (!owner?.contract.operations.some(operation => operation.operationId === effect.target.operationId))
            return homeGenerationFailure("spark_home_read_unavailable");
          input.signal.throwIfAborted();
        },
        async afterEffect() {},
      },
    });
    const descriptors: SparkHomeReadDescriptor[] = [];
    const bindings = new Map<string, { tool: string; operation: ToolNormalInvocationOperation; handle: typeof executor.operations[number]["handle"] }>();
    let position = 0;
    for (const registration of registrations) for (const operation of registration.contract.operations) {
      const id = `${registration.toolName}:${operation.operationId}`;
      const entry = executor.operations[position++];
      bindings.set(id, { tool: registration.toolName, operation, handle: entry.handle });
      descriptors.push({ id, tool: registration.toolName, summary: operation.summary, input: operation.input });
    }
    const seen = new Set<string>();
    const resourceBudget = createSparkHomeResourceReadBudget(bindings.get(SPARK_HOME_RESOURCE_READ_OPERATION)?.operation);
    return {
      get descriptors() { return resourceBudget.planning(descriptors).operations; },
      planning() { return resourceBudget.planning(descriptors); },
      resourcesAccess: bindings.has(SPARK_HOME_RESOURCE_READ_OPERATION) ? "allowed" as const : "blocked" as const,
      async read(selection: SparkHomeReadSelection, sources: SparkHomeAuthoringContext) {
        input.signal.throwIfAborted();
        const binding = bindings.get(selection.operation);
        if (!binding) return homeGenerationFailure("spark_home_read_unavailable");
        let controls = selection.controls;
        if (isSparkHomeResourceRead(selection.operation)) {
          assertHomeResourceBinding(controls, sources);
          controls = resourceBudget.prepareControls(controls);
        }
        const action = await executor.prepare({ handle: binding.handle, controls, intent: selection.purpose });
        if (action.status === "rejected") return projectSparkHomeEvidence(selection, "", action);
        if (seen.has(action.actionFingerprint)) return projectSparkHomeEvidence(selection, action.actionFingerprint,
          { status: "rejected", code: "spark_home_read_repeated", message: "The exact action was already attempted in this run." });
        seen.add(action.actionFingerprint);
        if (isSparkHomeResourceRead(selection.operation)) resourceBudget.consume(controls);
        input.signal.throwIfAborted();
        const result = await action.execute(randomUUID());
        input.signal.throwIfAborted();
        if (result.status === "rejected" && result.code === "tool_approval_rejected")
          return homeGenerationFailure("spark_home_approval_rejected");
        return projectSparkHomeEvidence(selection, action.actionFingerprint, result);
      },
      async dispose() {
        await resources.dispose();
        await resources.waitForQuiescence();
      },
    };
  } catch (error) {
    await resources.dispose();
    await resources.waitForQuiescence();
    throw error;
  }
}

function assertHomeResourceBinding(controls: Readonly<Record<string, unknown>>, sources: SparkHomeAuthoringContext): void {
  if (!sources.resourceBindings.some(source => source.sourceId === controls.sourceId && source.expectedRevision === controls.expectedRevision))
    return homeGenerationFailure("spark_home_resource_binding_invalid");
}

export type SparkHomeReadTools = Awaited<ReturnType<typeof createSparkHomeReadTools>>;
