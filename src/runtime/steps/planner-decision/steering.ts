import { isModelStepSteeringSuperseded } from "../../model/model-step-steering.js";
import { hasSuperContextContract } from "../../context/super-context-policy.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import {
  resolveRequestSteeringInbox,
  type RequestSteeringSnapshot,
} from "../../request/request-steering.js";

/** Only a canonical return from this Planner's own Worker grants this context. */
export function projectPlannerWorkerSteering(
  request: Pick<RequestExecutionScope, "executionPolicy" | "requestSteering">,
  call: RoleCallFrame,
  head: RoleCallLedgerHead,
): RequestSteeringSnapshot | undefined {
  if (!hasSuperContextContract(request.executionPolicy.authority, "delegated.planner"))
    return undefined;
  if (call.roleId !== "planner") return undefined;
  const baselines = head.state.results.flatMap((result) => {
    if (result.outcome !== "yielded") return [];
    const child = head.state.calls.find(
      (candidate) => candidate.callId === result.producerCallId,
    );
    if (child?.parentCallId !== call.callId) return [];
    if (child.roleId !== "worker") return [];
    return [child.workerSteeringVersion ?? 0];
  });
  if (baselines.length === 0) return undefined;
  const baseline = Math.min(...baselines);
  const current = resolveRequestSteeringInbox(
    request.requestSteering,
  ).snapshot();
  return Object.freeze({
    version: current.version,
    updates: Object.freeze(
      current.updates.filter((update) => update.sequence > baseline),
    ),
  });
}

/** Re-evaluate only an uncommitted caller decision if another update supersedes it. */
export async function decidePlannerWithWorkerSteering<T>(params: {
  request: RequestExecutionScope;
  call: RoleCallFrame;
  head: RoleCallLedgerHead;
  decide(steering: RequestSteeringSnapshot | undefined): Promise<T>;
}): Promise<Readonly<{ decision: T; steeringVersion: number }>> {
  const inbox = resolveRequestSteeringInbox(params.request.requestSteering);
  for (;;) {
    params.request.abortSignal.throwIfAborted();
    const version = inbox.snapshot().version;
    const steering = projectPlannerWorkerSteering(
      params.request,
      params.call,
      params.head,
    );
    try {
      const decision = await params.decide(steering);
      if (steering && !inbox.isCurrent(steering.version)) continue;
      return { decision, steeringVersion: steering?.version ?? version };
    } catch (error: unknown) {
      if (!steering || !isModelStepSteeringSuperseded(error)) throw error;
    }
  }
}

/** Historical remainder is exact source data, never an automatic instruction to resume. */
export function projectPlannerRetiredWork(
  head: RoleCallLedgerHead | undefined,
  call: RoleCallFrame,
) {
  const plan = head?.state.plans.find(
    (candidate) => candidate.definition.plannerCallId === call.callId,
  );
  if (!plan) return undefined;
  const retired = plan.itemStates.filter((item) => item.status === "retired");
  if (retired.length === 0) return undefined;
  const version = Math.max(
    ...retired.map((item) => item.retiredBySteeringVersion!),
  );
  const ids = new Set(
    retired
      .filter((item) => item.retiredBySteeringVersion === version)
      .map((item) => item.itemId),
  );
  return Object.freeze({
    kind: "runtime_planner_retired_work_v1",
    authority: "canonical_runtime_state",
    purpose: "Exact previous remainder for the caller's steering decision.",
    presenceEffect:
      "Historical assignments only; neither pending work nor completion evidence. Resume none automatically.",
    steeringVersion: version,
    entries: plan.definition.items.filter((item) => ids.has(item.itemId)),
    omittedCount: 0,
  });
}
