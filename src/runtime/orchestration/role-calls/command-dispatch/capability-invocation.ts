import { isOptionalRoleCapabilityIntent } from "../capability-intent.js";
import {
  isRoleCapabilityId,
  type BeginRoleCapabilityExecutionCommand,
  type RoleCapabilityDeclaredEffect,
} from "../contracts.js";
import {
  isExactJsonObjectString,
  isRoleCapabilityDeclaredEffect,
} from "../reducer-primitives.js";

type CapabilityInvocation = Pick<
  BeginRoleCapabilityExecutionCommand,
  "capabilityId" | "declaredEffect" | "intent" | "controlsJson"
>;

export function hasValidCapabilityInvocation(
  invocation: CapabilityInvocation,
  requiredDeclaredEffect?: RoleCapabilityDeclaredEffect,
): boolean {
  if (!isRoleCapabilityId(invocation.capabilityId)) return false;
  if (
    requiredDeclaredEffect !== undefined &&
    invocation.declaredEffect !== requiredDeclaredEffect
  ) {
    return false;
  }
  if (!isRoleCapabilityDeclaredEffect(invocation.declaredEffect)) return false;
  if (!isOptionalRoleCapabilityIntent(invocation.intent)) return false;
  return isExactJsonObjectString(invocation.controlsJson);
}
