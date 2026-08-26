import type { RegisteredToolNormalInvocationRejection } from "./contracts.js";

export function rejectNormalInvocation(
  code: string,
  message: string,
): RegisteredToolNormalInvocationRejection {
  return Object.freeze({ status: "rejected" as const, code, message });
}
