import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCallResult,
} from "./contracts.js";
import { traceDebug } from "../../observability/debug-logger.js";

const ROLE_DEPENDENCY_LOG_SCOPE = "runtime.role_dependencies";

export type RoleCallDependencyResult = Readonly<
  Pick<
    RoleCallResult,
    "resultRef" | "producerCallId" | "roleId" | "outcome" | "summary"
  >
>;

/**
 * Resolves only the canonical direct-sibling results attached to this call.
 * The role-executor boundary selects them mechanically; this projection
 * transports the already settled data without interpreting it.
 */
export function projectRoleCallDependencyResults(
  head: RoleCallLedgerHead,
  suppliedCall: RoleCallFrame,
): readonly RoleCallDependencyResult[] {
  try {
    const results = projectRoleCallDependencyResultsUnchecked(
      head,
      suppliedCall,
    );
    traceDebug(ROLE_DEPENDENCY_LOG_SCOPE, "input.projected", {
      requestId: head.state.requestId,
      sourceRevision: head.revision,
      callId: suppliedCall.callId,
      parentCallId: suppliedCall.parentCallId,
      roleId: suppliedCall.roleId,
      dependencyResultCount: results.length,
      dependencyResultRefs: results.map((result) => result.resultRef),
      dependencyRoleIds: results.map((result) => result.roleId),
      dependencyOutcomeCounts: results.reduce(
        (counts, result) => ({
          ...counts,
          [result.outcome]: counts[result.outcome] + 1,
        }),
        { completed: 0, failed: 0 },
      ),
      dependencySummaryLength: results.reduce(
        (total, result) => total + result.summary.length,
        0,
      ),
    });
    return results;
  } catch (error: unknown) {
    traceDebug(ROLE_DEPENDENCY_LOG_SCOPE, "input.rejected", {
      requestId: head.state.requestId,
      sourceRevision: head.revision,
      callId: suppliedCall.callId,
      parentCallId: suppliedCall.parentCallId,
      roleId: suppliedCall.roleId,
      dependencyResultCount: suppliedCall.dependencyResultRefs.length,
      dependencyResultRefs: suppliedCall.dependencyResultRefs,
      issueCode:
        error instanceof Error &&
        error.message.startsWith("role_call_dependency_")
          ? error.message
          : "role_call_dependency_projection_failed",
    });
    throw error;
  }
}

function projectRoleCallDependencyResultsUnchecked(
  head: RoleCallLedgerHead,
  suppliedCall: RoleCallFrame,
): readonly RoleCallDependencyResult[] {
  const call = head.state.calls.find(
    (candidate) => candidate.callId === suppliedCall.callId,
  );
  if (
    head.state.phase !== "running" ||
    head.state.activeCallId !== suppliedCall.callId ||
    call !== suppliedCall ||
    call.status !== "active"
  ) {
    throw new Error("role_call_dependency_authority_invalid");
  }

  const results = call.dependencyResultRefs.map((resultRef) => {
    const result = head.state.results.find(
      (candidate) => candidate.resultRef === resultRef,
    );
    const producer = head.state.calls.find(
      (candidate) => candidate.callId === result?.producerCallId,
    );
    if (
      !result ||
      !producer ||
      producer.parentCallId !== call.parentCallId ||
      producer.status !== "completed" ||
      producer.resultRef !== result.resultRef ||
      producer.roleId !== result.roleId
    ) {
      throw new Error("role_call_dependency_projection_invalid");
    }
    return Object.freeze({
      resultRef: result.resultRef,
      producerCallId: result.producerCallId,
      roleId: result.roleId,
      outcome: result.outcome,
      summary: result.summary,
    });
  });
  return Object.freeze(results);
}
