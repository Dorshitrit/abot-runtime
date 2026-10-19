import {
  executionCompactionScopeId,
  projectExecutionCompactionObjective,
} from "../../context/execution-compaction-objective.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import type {
  RoleCallFrame, RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import { buildExecutionCapabilityResultSource } from "./capability-result-context.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";

type ExecutionAgentCompactionOptions = Readonly<{
  call: RoleCallFrame;
  steeringSnapshot: RequestSteeringSnapshot;
  head: RoleCallLedgerHead;
  consumer?: ModelStep;
  allowedConsumers: readonly ModelStep[];
  scopeSuffix?: string;
}>;

export function createExecutionAgentCompactionController(
  request: RequestExecutionScope,
  options: ExecutionAgentCompactionOptions,
) {
  const objective = projectExecutionCompactionObjective(
    request.prompt,
    options.steeringSnapshot.updates,
  );
  const call = Object.freeze({ ...options.call, objective });
  return createModelStepCompactionController(request, {
    call,
    sourceRevision: options.head.revision,
    resultSourceOverrides: options.head.state.capabilityExecutions
      .filter(function isSettledExecutionOfCall(execution) {
        if (execution.callId !== call.callId) return false;
        return execution.status === "settled";
      })
      .map((execution) =>
        buildExecutionCapabilityResultSource(options.head, execution),
      ),
    allowedConsumers: options.allowedConsumers,
    consumer: options.consumer,
    scopeId: executionCompactionScopeId({
      callId: call.callId,
      prompt: request.prompt,
      objective,
      ...(options.scopeSuffix ? { scopeSuffix: options.scopeSuffix } : {}),
    }),
  });
}
