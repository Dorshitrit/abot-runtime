import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  resolveRoleCallTransactions,
} from "../orchestration/role-calls/index.js";
import { traceDebug } from "../observability/debug-logger.js";
import { attachRequestPlannerRoleCallEvents } from "./role-call-planner-events.js";
import type { RequestRunnerResult } from "./result.js";
import { runRootExecutionKernel } from "./root-execution-kernel.js";
import {
  persistSettledSessionArtifactPaths,
  type RequestArtifactPathPersistence,
} from "./session-artifact-path-persistence.js";
import {
  type RequestExecutionScope,
} from "./execution-scope.js";

const INITIAL_ROLE_CALL_LIMITS = Object.freeze({
  limits: Object.freeze({
    maxDepth: 12,
    maxCalls: 48,
    maxCapabilityExecutions: 96,
    maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
    maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
    maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
  }),
});

export async function runRequestRunner(
  request: RequestExecutionScope,
  options: Readonly<{
    persistArtifactPaths?: RequestArtifactPathPersistence;
  }> = {},
): Promise<RequestRunnerResult> {
  const executionPolicy = request.executionPolicy;
  if (
    request.executionPolicySelection?.policy !== undefined &&
    executionPolicy.authority.id !== request.executionPolicySelection.policy
  ) {
    throw new Error("execution_policy_selection_mismatch");
  }
  traceDebug("runtime.request", "request.execution_policy.selected", {
    requestId: request.requestId,
    policyId: executionPolicy.authority.id,
    policyVersion: executionPolicy.authority.version,
    source: request.executionPolicySelection?.source ?? "default",
    ...(request.executionPolicySelection?.primaryProfileId
      ? {
          primaryProfileId: request.executionPolicySelection.primaryProfileId,
        }
      : {}),
  });
  const ledger = createRoleCallLedger({
    requestId: request.requestId,
    policy: Object.freeze({
      authority: executionPolicy.authority,
      limits: INITIAL_ROLE_CALL_LIMITS.limits,
    }),
  });
  attachRequestPlannerRoleCallEvents({
    ledger,
    onEvent: request.onEvent,
  });
  let result: RequestRunnerResult;
  try {
    const created = await resolveRoleCallTransactions(ledger).createRoot({
      expectedHead: ledger.current(),
    });
    if (!created.ok) {
      throw new Error(`role_call_ledger_rejected:${created.issueCode}`);
    }
    result = await runRootExecutionKernel({
      request,
      ledger,
    });
  } catch (error: unknown) {
    await persistSettledSessionArtifactPaths({
      head: ledger.current(),
      sessionId: request.sessionId,
      trigger: "root_failed",
      ...(options.persistArtifactPaths
        ? { persistArtifactPaths: options.persistArtifactPaths }
        : {}),
    });
    throw error;
  }

  await persistSettledSessionArtifactPaths({
    head: ledger.current(),
    sessionId: request.sessionId,
    trigger: "root_succeeded",
    ...(options.persistArtifactPaths
      ? { persistArtifactPaths: options.persistArtifactPaths }
      : {}),
  });
  return deliverAnswer(request, result);
}

function deliverAnswer(
  request: Pick<RequestExecutionScope, "onAnswerToken">,
  result: RequestRunnerResult,
): RequestRunnerResult {
  request.onAnswerToken(result.output);
  return result;
}
