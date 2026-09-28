import { isDeepStrictEqual } from "node:util";
import type { ToolNormalInvocationPropertyInput } from "../../capabilities/normal-invocation/contracts.js";

/** Only provable subsets of the selected input authority may reach a request. */
export function isNarrowedInputProperty(
  original: ToolNormalInvocationPropertyInput,
  prepared: ToolNormalInvocationPropertyInput,
): boolean {
  if (isDeepStrictEqual(original, prepared)) return true;
  if (!("enum" in prepared)) return false;
  if ("enum" in original) {
    return prepared.enum.every((value) => original.enum.includes(value));
  }
  if (original.type !== "string") return false;
  return prepared.enum.every((value) => {
    if (value.length < original.minLength) return false;
    if ("maxLength" in original) return value.length <= original.maxLength;
    return true;
  });
}
