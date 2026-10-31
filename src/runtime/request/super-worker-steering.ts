import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import { hasSuperContextContract } from "../context/super-context-policy.js";
import type { RoleExecutionResult } from "../orchestration/role-executors/contracts.js";
import { createRoleSteeringYield } from "../orchestration/role-executors/activation/steering-yield.js";
import { assertBoundModelStepSteeringCurrent } from "../model/model-step-steering.js";
import type { RequestModelStepPort } from "../model/model-step-port.js";
import type { RequestExecutionScope, RequestCapabilityExecutionView } from "./execution-scope.js";
import { createFrozenSurface, enumerableGetter, hiddenValue } from "./immutable-view.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";

export function ownsSuperWorkerSteering(
  request: Pick<RequestExecutionScope, "executionPolicy">,
  call: Readonly<{ roleId: string }>,
): boolean {
  if (!hasSuperContextContract(request.executionPolicy.authority, "delegated.worker")) return false;
  return call.roleId === "worker";
}

export function projectSuperWorkerDelegationSteering(
  request: Pick<RequestExecutionScope, "executionPolicy">,
  roleId: string,
  steeringVersion: number,
): Readonly<{ workerSteeringVersion?: number }> {
  if (!ownsSuperWorkerSteering(request, { roleId })) return Object.freeze({});
  return Object.freeze({ workerSteeringVersion: steeringVersion });
}

export function assertSuperWorkerSteeringCurrent(
  request: RequestExecutionScope,
  call: RoleCallFrame,
): void {
  request.abortSignal.throwIfAborted();
  if (!ownsSuperWorkerSteering(request, call)) return;
  assertBoundModelStepSteeringCurrent(
    resolveRequestSteeringInbox(request.requestSteering),
    call.workerSteeringVersion ?? 0,
  );
}

/** Preserve the request facets while binding every Worker model call to its assignment. */
export function bindSuperWorkerSteering(
  request: RequestExecutionScope,
  call: RoleCallFrame,
): RequestExecutionScope {
  if (!ownsSuperWorkerSteering(request, call)) return request;
  const modelSteps: RequestModelStepPort = Object.freeze({
    invoke: (input) => request.modelSteps.invoke({
      ...input,
      boundSteeringVersion: call.workerSteeringVersion ?? 0,
    }),
  });
  const executionContext = createFrozenSurface<RequestCapabilityExecutionView>({
    ...Object.getOwnPropertyDescriptors(request.workerCapabilities.executionContext),
    modelSteps: enumerableGetter(() => modelSteps),
  });
  const workerCapabilities = Object.freeze({
    ...request.workerCapabilities,
    executionContext,
  });
  return createFrozenSurface<RequestExecutionScope>({
    ...Object.getOwnPropertyDescriptors(request),
    modelSteps: enumerableGetter(() => modelSteps),
    workerCapabilities: enumerableGetter(() => workerCapabilities),
    capabilities: hiddenValue(workerCapabilities),
  });
}

export function createSuperWorkerSteeringYield(
  request: RequestExecutionScope,
  call: RoleCallFrame,
  maxSummaryLength: number,
): RoleExecutionResult<never> {
  request.abortSignal.throwIfAborted();
  const version = resolveRequestSteeringInbox(request.requestSteering).snapshot().version;
  if (!ownsSuperWorkerSteering(request, call)) throw new Error("worker_steering_owner_invalid");
  if (version <= (call.workerSteeringVersion ?? 0)) throw new Error("worker_steering_version_not_advanced");
  return createRoleSteeringYield(version, maxSummaryLength);
}
