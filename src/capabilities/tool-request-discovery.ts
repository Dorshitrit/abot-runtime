import type { CanonicalToolDefinitionDeclaration } from "./tool-types.js";
import type { ToolNormalInvocationContract } from "./normal-invocation/contracts.js";

/** Availability discovery has no executable handlers or request authority. */
export type ToolDiscoveryDeclaration = Readonly<{
  definition: CanonicalToolDefinitionDeclaration;
  normalInvocation: ToolNormalInvocationContract;
}>;

/** Return only the names of selected capabilities currently available to Agents. */
export type ToolCapabilityDiscovery = (
  selected: readonly ToolDiscoveryDeclaration[],
) => Promise<readonly string[]>;

export function parseRequestBindingRequirement(value: unknown, path: string): true | undefined {
  if (value === undefined) return undefined;
  if (value === true) return true;
  throw new Error(`${path} must be true when declared`);
}
