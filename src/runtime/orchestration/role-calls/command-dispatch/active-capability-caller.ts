import { hasCapabilityAuthority } from "../candidate-validation.js";
import type {
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallState,
} from "../contracts.js";
import { findCall } from "../reducer-primitives.js";

export function findActiveCapabilityCaller(params: {
  state: RoleCallState;
  policy: RoleCallPolicy;
  callId: string;
}): RoleCallFrame | undefined {
  if (params.state.phase !== "running") return undefined;
  if (params.state.activeCallId !== params.callId) return undefined;

  const call = findCall(params.state, params.callId);
  if (call?.status !== "active") return undefined;
  if (!hasCapabilityAuthority(params.policy.authority, params.state, call)) {
    return undefined;
  }
  return call;
}
