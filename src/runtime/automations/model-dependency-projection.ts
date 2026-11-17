import { ModelReasoningConfigurationError } from "../../shared/model-reasoning.js";
import {
  ModelInvocationResolutionError, resolveModelInvocation,
} from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { MODEL_STEPS, type ModelStep } from "../../shared/model-steps.js";
import { supportsRequestExecutionPolicy } from "../../shared/request-execution-policy.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import { resolveConfiguredStepInstructionMetadata } from "../config/runner/step-instructions.js";
import { resolveModelStepTimeout } from "../model/model-step-timeout-policy.js";
import type { RuntimeConfig } from "../ports.js";
import type { AgentNode, OperationRef } from "./definition-contracts.js";
import type { AutomationCatalogOperation } from "./catalog.js";
import { createAutomationAgentModelSelection } from "./agent-model-selection.js";
import { sameOperation } from "./permission-grants.js";
import type { RequestExecutionPolicyId } from "../config/model-execution-policy.js";

// Root and delegated contracts in request/role-executor-composition.ts own these paths.
// The delegated Planner also invokes planner.graph; the direct Planner invokes only that step.
const POLICY_MODEL_STEPS = {
  "supervisor-worker-v1": [MODEL_STEPS.SUPERVISOR_DECISION, MODEL_STEPS.SUPERVISOR_RESPONSE,
    MODEL_STEPS.PLANNER_DECISION, MODEL_STEPS.PLANNER_GRAPH, MODEL_STEPS.WORKER_DECISION,
    MODEL_STEPS.WORKER_RESULT, MODEL_STEPS.REVIEWER_DECISION],
  "execution-agent-v1": [MODEL_STEPS.EXECUTION_DECISION, MODEL_STEPS.EXECUTION_RESPONSE,
    MODEL_STEPS.PLANNER_GRAPH, MODEL_STEPS.AUDITOR_DECISION],
} as const satisfies Record<RequestExecutionPolicyId, readonly ModelStep[]>;

function reachableModelSteps(policy: RequestExecutionPolicyId, hasTools: boolean): readonly ModelStep[] {
  // Both policies can compact or finalize a failed request. Tool helpers need an allowed operation.
  // Passive learning is a separate background request, never part of an automation agent attempt.
  return [...POLICY_MODEL_STEPS[policy], MODEL_STEPS.CONTEXT_COMPACTION, MODEL_STEPS.DEGRADED_FINALIZATION,
    ...(hasTools ? [MODEL_STEPS.CAPABILITY_CONTROLS, MODEL_STEPS.TOOL_PAYLOAD_RAW] : []),
    ...(hasTools && policy === "execution-agent-v1" ? [MODEL_STEPS.EXECUTION_FILE_PAYLOAD_RAW] : [])];
}

function configuredInstructionDependency(runnerConfig: RequestRunnerConfig | undefined, modelStep: ModelStep) {
  if (!runnerConfig) return undefined;
  const metadata = resolveConfiguredStepInstructionMetadata({ runnerConfig, modelStep });
  if (metadata.blockCount === 0) return undefined;
  return metadata;
}

function invocationDependency(input: {
  node: AgentNode;
  modelStep: ModelStep;
  modelPolicy: ModelGatewayPolicyConfig | undefined;
  runnerConfig: RequestRunnerConfig | undefined;
}) {
  const modelPreference = { profileId: input.node.modelProfileId, scope: "all" as const };
  const dependency = { modelStep: input.modelStep,
    instructions: configuredInstructionDependency(input.runnerConfig, input.modelStep) };
  try {
    const invocation = resolveModelInvocation({
      agentMode: input.node.agentMode, modelPreference,
      ...(input.node.reasoningPreference ? { reasoningPreference: input.node.reasoningPreference } : {}),
      modelStep: input.modelStep, modelPolicy: input.modelPolicy,
    });
    // Unused calibration slots and display labels are not execution dependencies.
    const { label: _label, calibration: _calibration, ...profile } = invocation.profile;
    const timeout = resolveModelStepTimeout({
      modelStep: input.modelStep, modelPreference, modelPolicy: input.modelPolicy,
      fallbackTimeoutMs: input.runnerConfig?.steps[input.modelStep]?.timeoutMs ?? 0,
    });
    return { ...dependency, ...invocation, profile, timeoutMs: timeout.timeoutMs };
  } catch (error) {
    if (!(error instanceof ModelInvocationResolutionError) && !(error instanceof ModelReasoningConfigurationError)) throw error;
    return { ...dependency, unavailable: error.code };
  }
}

function projectUnavailableAgentOperations(
  references: readonly OperationRef[], operations: readonly AutomationCatalogOperation[],
  policy: RequestExecutionPolicyId,
): readonly string[] {
  const unavailable = new Set<string>();
  for (const reference of references) {
    const operation = operations.find((candidate) => sameOperation(candidate, reference));
    // Missing contracts already invalidate the operation dependency itself.
    if (!operation) continue;
    if (supportsRequestExecutionPolicy(operation.executionPolicies, policy)) continue;
    unavailable.add(JSON.stringify([reference.toolName, reference.operationId, reference.contractVersion]));
  }
  return [...unavailable].sort();
}

/** Projects canonical routing outcomes, never an unrelated model catalog. */
export function projectAutomationModelDependencies(config: RuntimeConfig, nodes: readonly AgentNode[],
  operations: readonly AutomationCatalogOperation[] = []) {
  if (nodes.length === 0) return undefined;
  const models = createAutomationAgentModelSelection(config);
  const { runnerConfig: runner, modelPolicy } = models;
  const selected = new Map<string, { node: AgentNode; tools: OperationRef[] }>();
  for (const node of nodes) {
    const key = JSON.stringify(node.reasoningPreference ? [node.modelProfileId, node.agentMode, node.reasoningPreference] : [node.modelProfileId, node.agentMode]);
    const tools = [...(selected.get(key)?.tools ?? []), ...node.tools.map((tool) => tool.operation)];
    selected.set(key, { node, tools });
  }
  return {
    modelGatewayUrl: config.modelGatewayUrl,
    // Every Agent invocation uses these canonical admission/compaction reserves.
    contextBudget: runner?.context,
    agents: [...selected.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, { node, tools }]) => {
      const execution = models.execution(node).execution;
      const unavailableOperations = projectUnavailableAgentOperations(tools, operations, execution.policy);
      return {
        key,
        admission: models.admission(node).execution,
        execution,
        // Preserve existing publications when their effective tool availability is unchanged.
        ...(unavailableOperations.length > 0 ? { unavailableOperations } : {}),
        invocations: reachableModelSteps(execution.policy, tools.length > 0).map((modelStep) => invocationDependency({
          node, modelStep, modelPolicy, runnerConfig: runner,
        })),
      };
    }),
  };
}
