import type { RoleExecutor } from "../orchestration/role-executors/index.js";
import { SuperContextFailure } from "../context/super-context-failure.js";
import { hasSuperContextContract } from "../context/super-context-policy.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import { hasSafeSuperContextFailureReturn } from "./super-context-failure-integrity.js";
import { quarantineProvenUnusableSuperCheckpoint } from "./super-checkpoint-quarantine.js";
import { requireLiveSuperContextScope } from "./super-context-scope.js";

/** The existing activation/return transaction remains the only role-state writer. */
export function containSuperContextFailures<TValue>(
  executor: RoleExecutor<RequestExecutionScope, TValue>,
  contractId: string,
): RoleExecutor<RequestExecutionScope, TValue> {
  return Object.freeze({
    roleId: executor.roleId,
    async execute(input) {
      const request = input.context;
      if (
        !hasSuperContextContract(request.executionPolicy.authority, contractId)
      )
        return executor.execute(input);
      const expectedHead = input.ledger.current();
      request.abortSignal.throwIfAborted();
      try {
        requireLiveSuperContextScope({
          request,
          head: expectedHead,
          call: input.call,
          contractId,
        });
        return await executor.execute(input);
      } catch (error: unknown) {
        request.abortSignal.throwIfAborted();
        const integrity = {
          error,
          request,
          ledger: input.ledger,
          expectedHead,
          call: input.call,
          contractId,
        };
        quarantineProvenUnusableSuperCheckpoint(integrity);
        if (!hasSafeSuperContextFailureReturn(integrity)) throw error;
        const failure = error as SuperContextFailure;
        traceDebug("runtime.context.compaction", "owned_failure.returning", {
          ...failure.binding,
          code: failure.code,
          route: "return_failed_child",
        });
        return Object.freeze({
          kind: "terminal" as const,
          outcome: "failed" as const,
          summary: failureSummary(
            failure,
            expectedHead.policy.limits.maxResultChars,
          ),
        });
      }
    },
  });
}

function failureSummary(
  failure: SuperContextFailure,
  maxLength: number,
): string {
  const capsule = JSON.stringify({
    kind: "runtime_role_context_failure_v1",
    authority: "runtime_failure",
    presenceEffect: "passive_failure_not_work_or_review_evidence",
    ...failure.binding,
    reason: failure.code,
  });
  if (capsule.length <= maxLength) return capsule;
  if (maxLength >= 22) return "Context step failed.";
  if (maxLength >= 7) return "Failed.";
  return "!";
}
