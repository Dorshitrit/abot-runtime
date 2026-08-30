import type {
  BeginRoleCapabilityExecutionCommand,
  RoleCallState,
  RoleCapabilityExecution,
} from "../contracts.js";

type RunningCapabilityExecutionInput = Pick<
  BeginRoleCapabilityExecutionCommand,
  | "callId"
  | "invocationAttempt"
  | "capabilityId"
  | "declaredEffect"
  | "intent"
  | "controlsJson"
  | "actionFingerprint"
> &
  Readonly<{ executionId: string }>;

export function createRunningCapabilityExecution(
  input: RunningCapabilityExecutionInput,
): RoleCapabilityExecution {
  return {
    executionId: input.executionId,
    callId: input.callId,
    invocationAttempt: input.invocationAttempt,
    capabilityId: input.capabilityId,
    declaredEffect: input.declaredEffect,
    intent: input.intent.trim(),
    controlsJson: input.controlsJson,
    ...(input.actionFingerprint
      ? { actionFingerprint: input.actionFingerprint }
      : {}),
    status: "running",
    outcome: null,
    outcomeFingerprint: null,
    observedEffect: null,
    summary: null,
  };
}

export function findCapabilityExecution(
  state: RoleCallState,
  executionId: string,
): RoleCapabilityExecution | undefined {
  return state.capabilityExecutions.find(
    (execution) => execution.executionId === executionId,
  );
}

export function replaceCapabilityExecution(
  executions: readonly RoleCapabilityExecution[],
  replacement: RoleCapabilityExecution,
): RoleCapabilityExecution[] {
  return executions.map((execution) =>
    execution.executionId === replacement.executionId ? replacement : execution,
  );
}

export function nextCapabilityExecutionId(
  state: RoleCallState,
  offset = 0,
): string {
  return `capability-execution-${state.capabilityExecutionSequence + offset + 1}`;
}
