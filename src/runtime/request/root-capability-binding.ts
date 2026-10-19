import { createRootExecutionFreshness } from "./capability-execution-freshness.js";
import { createRoleCapabilityBinding, type WorkerCapabilityBinding } from "../orchestration/worker-capabilities/index.js";
import { resolveRoleCallTransactions, type RoleCallLedger, type RoleCallLedgerHead, type RoleCallFrame } from "../orchestration/role-calls/index.js";
import { RUNTIME_ROOT_ROLE_ID } from "../orchestration/roles.js";
import type { RequestExecutionScope, RequestCapabilityExecutionView } from "./execution-scope.js";
import type { RootActivation } from "./root-execution-contracts.js";
import type { RootContractDecision } from "./root-contract.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";

/** Existing root capability preparation, shared without changing either policy's execution path. */
export async function prepareRootCapabilityBinding(params: {
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
  activation: RootActivation & Readonly<{ decisionSteeringVersion: number }>;
  decision: Extract<RootContractDecision, { action: "invoke_capability" | "invoke_capabilities" }>;
}): Promise<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  binding: WorkerCapabilityBinding<RequestCapabilityExecutionView>;
}> {
  const { request, ledger, activation, decision } = params;
  const transactions = resolveRoleCallTransactions(ledger);
  const requestSteering = resolveRequestSteeringInbox(request.requestSteering);
  let head = activation.head;
  let call = activation.call;
  if (decision.workingDirectory !== undefined) {
    const established = await transactions.establishWorkingDirectory({
      expectedHead: head,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      workingDirectory: decision.workingDirectory,
    });
    if (!established.ok) {
      throw new Error(`role_call_ledger_rejected:${established.issueCode}`);
    }
    head = established.commit.head;
    call = requireRootCallFrame({ head, callId: call.callId });
  }
  const binding = createRoleCapabilityBinding({
    requestId: request.requestId,
    context: request.workerCapabilities.executionContext,
    call,
    ledger,
    adapters: request.workerCapabilities.provider.getAdapters(),
    ...(request.approvalGate
      ? { approvalGate: request.approvalGate }
      : {}),
    ...(request.executionPolicy.authority.capabilityAuthorities.includes("root")
      ? {
          executionFreshness: createRootExecutionFreshness({
            requestSteering,
            steeringVersion: activation.decisionSteeringVersion,
          }),
        }
      : {}),
  });
  return { head, call, binding };
}

export function requireRootCallFrame(params: {
  head: RoleCallLedgerHead;
  callId: string;
}): RoleCallFrame {
  const call = params.head.state.calls.find(
    (candidate) => candidate.callId === params.callId,
  );
  if (
    !call ||
    call.callId !== params.head.state.rootCallId ||
    call.parentCallId !== null ||
    call.roleId !== RUNTIME_ROOT_ROLE_ID ||
    call.depth !== 0 ||
    call.status !== "active"
  ) {
    throw new Error("supervisor_call_frame_missing");
  }
  return call;
}
