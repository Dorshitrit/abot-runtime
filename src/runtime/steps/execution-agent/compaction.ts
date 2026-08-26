import type { ModelStep } from "../../../shared/model-steps.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";

type ExecutionAgentCompactionOptions = Readonly<{
  call: RoleCallFrame;
  sourceRevision: number;
  allowedConsumers: readonly ModelStep[];
  scopeSuffix?: string;
}>;

export function createExecutionAgentCompactionController(
  request: RequestExecutionScope,
  options: ExecutionAgentCompactionOptions,
) {
  const call = options.call.objective
    ? options.call
    : Object.freeze({ ...options.call, objective: request.prompt });
  return createModelStepCompactionController(request, {
    call,
    sourceRevision: options.sourceRevision,
    allowedConsumers: options.allowedConsumers,
    ...(options.scopeSuffix ? { scopeSuffix: options.scopeSuffix } : {}),
  });
}
