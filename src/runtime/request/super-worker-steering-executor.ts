import { isModelStepSteeringSuperseded } from "../model/model-step-steering.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import {
  assertSuperWorkerSteeringCurrent,
  bindSuperWorkerSteering,
  createSuperWorkerSteeringYield,
  ownsSuperWorkerSteering,
} from "./super-worker-steering.js";
import type { RoleExecutor, RoleExecutorInput } from "../orchestration/role-executors/contracts.js";
import { executeRoleWithModelOutputFailure } from "../orchestration/role-executors/activation/model-output-failure.js";

/** Composed only around SUPER's Worker; generic role execution stays policy-free. */
export function bindSuperWorkerSteeringExecutor<TValue>(
  executor: RoleExecutor<RequestExecutionScope, TValue>,
): RoleExecutor<RequestExecutionScope, TValue> {
  return Object.freeze({
    roleId: executor.roleId,
    async execute(input: RoleExecutorInput<RequestExecutionScope>) {
      const { context, call } = input;
      if (!ownsSuperWorkerSteering(context, call)) return executor.execute(input);
      try {
        assertSuperWorkerSteeringCurrent(context, call);
        // Reuse failure normalization before the terminal freshness guard so a
        // failed in-flight model call cannot hide a newly arrived user update.
        const result = await executeRoleWithModelOutputFailure(
          executor,
          { ...input, context: bindSuperWorkerSteering(context, call) },
          input.ledger.current().policy.limits.maxResultChars,
          context.requestId,
        );
        // Settled capabilities first commit their existing continuation. The
        // next activation yields without discarding receipts or advancing work.
        if (result.kind === "terminal") assertSuperWorkerSteeringCurrent(context, call);
        return result;
      } catch (error: unknown) {
        if (!isModelStepSteeringSuperseded(error)) throw error;
        return createSuperWorkerSteeringYield(
          context, call, input.ledger.current().policy.limits.maxResultChars,
        );
      }
    },
  });
}
