import type { RoleCallFrame, RoleCallState } from "../contracts.js";

export function replaceCall(
  calls: readonly RoleCallFrame[],
  replacement: RoleCallFrame,
): RoleCallFrame[] {
  return calls.map((call) =>
    call.callId === replacement.callId ? replacement : call,
  );
}

export function nextCallId(state: RoleCallState): string {
  return `call-${state.callSequence + 1}`;
}
