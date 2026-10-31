import type {
  RoleCallFrame,
  ExecutionPolicyAuthoritySnapshot,
} from "../orchestration/role-calls/index.js";
import { hasSuperContextContract } from "../context/super-context-policy.js";
import type { BoundRequestModelInvocationContext } from "./contracts.js";
import { createFrozenSurface, enumerableGetter } from "./immutable-view.js";

/** Binds payload model calls to the accepted Worker assignment, without user-context injection. */
export function bindWorkerPayloadSteering<
  T extends BoundRequestModelInvocationContext,
>(
  request: T,
  call: RoleCallFrame,
  authority: ExecutionPolicyAuthoritySnapshot | undefined,
): T {
  if (!authority || !hasSuperContextContract(authority, "delegated.worker"))
    return request;
  if (call.roleId !== "worker" || call.parentCallId === null) return request;
  const port = request.modelSteps;
  const modelSteps = Object.freeze({
    invoke: <TResult>(
      input: import("../model/model-step-port.js").ModelStepInvocationInput<TResult>,
    ) =>
      port.invoke({
        ...input,
        boundSteeringVersion: call.workerSteeringVersion ?? 0,
      }),
  });
  return createFrozenSurface<T>({
    ...Object.getOwnPropertyDescriptors(request),
    modelSteps: enumerableGetter(() => modelSteps),
  });
}
