import type { CapabilityJsonObject } from "../orchestration/capability-adapters/result.js";
import type {
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../orchestration/role-calls/index.js";

export type AcceptedCapabilityAction = Readonly<{
  executionId: string;
  capabilityId: string;
  controls: CapabilityJsonObject;
  declaredEffect: RoleCapabilityExecution["declaredEffect"];
  workingDirectory: string | null;
}>;

/** Projects the exact non-payload controls committed with one execution. */
export function projectAcceptedCapabilityAction(
  head: RoleCallLedgerHead,
  execution: RoleCapabilityExecution,
): AcceptedCapabilityAction {
  const originCall = head.state.calls.find(
    ({ callId }) => callId === execution.callId,
  );
  if (!originCall) {
    throw new Error("accepted_capability_action_origin_call_invalid");
  }
  return Object.freeze({
    executionId: execution.executionId,
    capabilityId: execution.capabilityId,
    controls: parseAcceptedControls(execution.controlsJson),
    declaredEffect: execution.declaredEffect,
    workingDirectory: originCall.workingDirectory ?? null,
  });
}

function parseAcceptedControls(controlsJson: string): CapabilityJsonObject {
  let decoded: unknown;
  try {
    decoded = JSON.parse(controlsJson) as unknown;
  } catch {
    throw new Error("accepted_capability_action_controls_invalid");
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw new Error("accepted_capability_action_controls_invalid");
  }
  return Object.freeze(decoded as CapabilityJsonObject);
}
