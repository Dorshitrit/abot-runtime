import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { projectRequestContext } from "../../context/request-context.js";
import { buildRequestTemporalContextMessage } from "../../context/request-temporal-context.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import {
  EXECUTION_AGENT_PLANNER_GRAPH_LIMITS,
  PLANNER_GRAPH_MODEL_STEP,
  type PlannerGraphLimits,
} from "./contracts.js";
import { createPlannerGraphFormat } from "./format.js";
import { buildPlannerGraphInstructions } from "./prompt.js";

export function buildPlannerGraphInput(
  request: RequestExecutionSeed,
  call: RoleCallFrame,
  limits: PlannerGraphLimits = EXECUTION_AGENT_PLANNER_GRAPH_LIMITS,
): Readonly<{
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  modelStep: typeof PLANNER_GRAPH_MODEL_STEP;
  limits: PlannerGraphLimits;
}> {
  if (
    call.roleId !== "planner" ||
    call.parentCallId === null ||
    call.status !== "active" ||
    !call.objective
  ) {
    throw new Error("planner_graph_call_invalid");
  }
  const format = createPlannerGraphFormat(limits);
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: PLANNER_GRAPH_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const prompt = JSON.stringify({
    kind: "runtime_execution_agent_planner_assignment_v1",
    authority: "role_call_objective",
    presenceEffect: "advisory_assignment_only_not_execution_or_completion",
    plannerCallId: call.callId,
    objective: call.objective,
    limits,
  });
  return Object.freeze({
    context: projectRequestContext({
      instructions: buildPlannerGraphInstructions(),
      format,
      historyMessages: [],
      prompt,
      ...(request.temporalContext
        ? {
            referenceMessages: [
              buildRequestTemporalContextMessage(request.temporalContext),
            ],
          }
        : {}),
      budget,
      diagnostic: {
        requestId: request.requestId,
        modelStep: PLANNER_GRAPH_MODEL_STEP,
        callId: call.callId,
      },
      onEvent: request.onEvent,
      deferCompactionFailure: true,
    }),
    format,
    modelStep: PLANNER_GRAPH_MODEL_STEP,
    limits,
  });
}
