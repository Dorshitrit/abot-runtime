import {
  resolveRoleCallTransactions,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import type { ModelWorkPlanUpdate } from "../orchestration/role-calls/work-plan-contracts.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";
import type { RequestExecutionScope } from "./execution-scope.js";

/** Commit the model's declaration, not the eventual outcome of its paired action. */
export async function applyRootModelWorkPlan(params: {
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  steeringVersion: number;
  update: ModelWorkPlanUpdate;
}): Promise<
  Readonly<{ head: RoleCallLedgerHead; call: RoleCallFrame }> | undefined
> {
  params.request.abortSignal.throwIfAborted();
  const steering = resolveRequestSteeringInbox(params.request.requestSteering);
  if (!steering.isCurrent(params.steeringVersion)) return undefined;
  const result = await resolveRoleCallTransactions(
    params.ledger,
  ).updateModelWorkPlan({
    expectedHead: params.head,
    callId: params.call.callId,
    invocationAttempt: params.call.activationCount,
    update: params.update,
  });
  if (!result.ok)
    throw new Error(`role_call_ledger_rejected:${result.issueCode}`);
  const head = result.commit.head;
  const call = head.state.calls.find(
    (candidate) => candidate.callId === params.call.callId,
  )!;
  return { head, call };
}
