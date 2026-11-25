import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";

/** File authors may gather evidence; the accepted write remains their only mutation. */
export function isFilePayloadObservationCapability(
  capability: Pick<CapabilityDescriptor, "effect">,
): boolean {
  return capability.effect === "observation";
}

/** Apply after canonical capability scope validation, without interpreting tool semantics. */
export function projectFilePayloadObservationCapabilities(
  capabilities: readonly CapabilityDescriptor[],
): readonly CapabilityDescriptor[] {
  return Object.freeze(capabilities.filter(isFilePayloadObservationCapability));
}
