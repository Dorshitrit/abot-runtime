import {
  isRoleCapabilityId,
  ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH,
  type BeginRoleCapabilityExecutionCommand,
  type RoleCapabilityDeclaredEffect,
} from "../contracts.js";
import {
  isBoundedText,
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
  if (
    !isBoundedText(
      invocation.intent,
      ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH,
    )
  ) {
    return false;
  }
  return isExactJsonObjectString(invocation.controlsJson);
}
