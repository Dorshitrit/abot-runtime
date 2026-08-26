import {
  type RoleExecutorAttemptDiagnosticContext,
  traceRoleExecutorResolved,
} from "../diagnostics.js";

export type RoleExecutorDiagnosticContext = Parameters<
  typeof traceRoleExecutorResolved
>[0];

export function createDiagnostic(
  input: RoleExecutorDiagnosticContext,
): RoleExecutorDiagnosticContext {
  return Object.freeze(input);
}

export function createAttemptDiagnostic(
  input: Readonly<{
    requestId: unknown;
    callId: unknown;
    attemptedRoleId?: RoleExecutorAttemptDiagnosticContext["attemptedRoleId"];
    registeredRoleIds: RoleExecutorAttemptDiagnosticContext["registeredRoleIds"];
  }>,
): RoleExecutorAttemptDiagnosticContext {
  return Object.freeze({
    requestIdLength: boundedAttemptLength(input.requestId),
    callIdLength: boundedAttemptLength(input.callId),
    ...(input.attemptedRoleId
      ? { attemptedRoleId: input.attemptedRoleId }
      : {}),
    registeredRoleIds: input.registeredRoleIds,
  });
}

function boundedAttemptLength(input: unknown): number {
  return typeof input === "string" ? Math.min(input.length, 257) : 0;
}
