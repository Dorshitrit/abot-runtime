import {
  executionCompactionScopeId,
  projectExecutionCompactionObjective,
} from "../../context/execution-compaction-objective.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";

type ExecutionAgentCompactionOptions = Readonly<{
  call: RoleCallFrame;
  steeringSnapshot: RequestSteeringSnapshot;
  sourceRevision: number;
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
    sourceRevision: options.sourceRevision,
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
