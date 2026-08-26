import {
  invokeStructuredModelStep,
  StructuredModelInvalidOutputError,
} from "../../model/invoke-structured-step.js";
import {
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
} from "../../orchestration/role-calls/index.js";
import type { RoleExecutor } from "../../orchestration/role-executors/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestRoleExecutionHandoff } from "../../request/result.js";
import type { PlannerGraphOutcome } from "./contracts.js";
import { PLANNER_GRAPH_MODEL_STEP } from "./contracts.js";
import { PLANNER_DECISION_MODEL_STEP } from "../planner-decision/contracts.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import { buildPlannerGraphInput } from "./input.js";
import { parsePlannerGraphOutput } from "./parser.js";

export async function runPlannerGraph(
  request: RequestExecutionScope,
  call: RoleCallFrame,
): Promise<PlannerGraphOutcome> {
  const input = buildPlannerGraphInput(request, call);
  return invokeStructuredModelStep({
    request,
    modelStep: input.modelStep,
    format: input.format,
    messages: input.context.messages,
    contextCompaction: createModelStepCompactionController(request, {
      call,
      sourceRevision: call.activationCount,
      allowedConsumers: Object.freeze([
        PLANNER_DECISION_MODEL_STEP,
        PLANNER_GRAPH_MODEL_STEP,
      ]),
    }),
    timeoutReason: "planner_graph_timeout",
    invalidOutputReason: "invalid_planner_graph",
    parse: (text) => parsePlannerGraphOutput(text, input.limits),
  });
}

export const EXECUTION_AGENT_PLANNER_EXECUTOR: RoleExecutor<
  RequestExecutionScope,
  RequestRoleExecutionHandoff
> = Object.freeze({
  roleId: "planner",
  async execute({ context, call, continuation }) {
    if (continuation) {
      return failedAdvisory("planner_graph_continuation_unsupported");
    }
    try {
      const outcome = await runPlannerGraph(context, call);
      const summary = JSON.stringify({
        kind: "runtime_execution_agent_planner_advisory_v1",
        authority: "model_advisory",
        presenceEffect: "passive_result_not_execution_or_completion",
        plannerCallId: call.callId,
        ...outcome,
      });
      if (summary.length > ROLE_CALL_RESULT_MAX_LENGTH) {
        return failedAdvisory("planner_graph_result_not_admissible");
      }
      return Object.freeze({
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary,
      });
    } catch (error: unknown) {
      if (error instanceof StructuredModelInvalidOutputError) {
        return failedAdvisory("invalid_planner_graph");
      }
      throw error;
    }
  },
});

function failedAdvisory(reason: string) {
  return Object.freeze({
    kind: "terminal" as const,
    outcome: "failed" as const,
    summary: JSON.stringify({
      kind: "runtime_execution_agent_planner_advisory_v1",
      authority: "runtime_validation",
      presenceEffect: "passive_result_not_execution_or_completion",
      outcome: "invalid",
      reason,
    }),
  });
}
