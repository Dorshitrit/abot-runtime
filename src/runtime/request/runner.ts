import { createRequestRoleCallPolicy } from "./role-call-policy.js";
import { restoreApprovalExecutionFreshness } from "./capability-execution-freshness.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { isRoleApprovalWait } from "../orchestration/role-executors/approval-continuation.js";
import type { BoundApprovalDecision } from "../orchestration/worker-capabilities/approval-contracts.js";
import { resumeCapabilityApprovalGroup } from "../orchestration/worker-capabilities/execution/approval-group.js";
import {
  createRoleApprovalContinuation,
  validateRequestApprovalContinuation,
  type RequestApprovalContinuation,
  type RequestRunnerOutcome,
} from "./approval-continuation.js";
import type { RootApprovalWait } from "./root-execution-contracts.js";
import {
  createRoleCallLedger,
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
import { type RequestExecutionScope } from "./execution-scope.js";

type RequestRunnerOptions = Readonly<{
  persistArtifactPaths?: RequestArtifactPathPersistence;
  durableApproval?: boolean;
  continuation?: RequestApprovalContinuation;
  decisions?: readonly BoundApprovalDecision[];
}>;

export function runRequestRunner(
  request: RequestExecutionScope,
  options: RequestRunnerOptions & { durableApproval: true },
): Promise<RequestRunnerOutcome>;
export function runRequestRunner(
  request: RequestExecutionScope,
  options?: RequestRunnerOptions & { durableApproval?: false },
): Promise<RequestRunnerResult>;
export async function runRequestRunner(
  request: RequestExecutionScope,
  options: RequestRunnerOptions = {},
): Promise<RequestRunnerResult | RequestRunnerOutcome> {
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
    ...(options.continuation
      ? { checkpoint: options.continuation.ledger }
      : {}),
    policy: createRequestRoleCallPolicy(executionPolicy),
  });
  attachRequestPlannerRoleCallEvents({
    ledger,
    onEvent: request.onEvent,
  });
  let result: RequestRunnerResult | RootApprovalWait;
  try {
    let continuation;
    if (options.continuation) {
      validateRequestApprovalContinuation(
        options.continuation,
        ledger,
        request.workerCapabilities.provider.getDescriptors(),
      );
      const executionFreshness = restoreApprovalExecutionFreshness(
        options.continuation.preparedGroup.executionFreshnessToken,
        request.requestSteering,
      );
      const settled = await resumeCapabilityApprovalGroup({
        ...(executionFreshness ? { executionFreshness } : {}),
        ledger,
        context: request.workerCapabilities.executionContext,
        adapters: request.workerCapabilities.provider.getAdapters(),
        group: options.continuation.preparedGroup,
        decisions: options.decisions ?? [],
      });
      continuation = createRoleApprovalContinuation(
        options.continuation,
        settled.executionIds,
      );
    } else {
      const created = await resolveRoleCallTransactions(ledger).createRoot({
        expectedHead: ledger.current(),
      });
      if (!created.ok)
        throw new Error(`role_call_ledger_rejected:${created.issueCode}`);
    }
    result = await runRootExecutionKernel({
      request,
      ledger,
      durableApproval: true,
      ...(continuation ? { continuation } : {}),
      ...(options.continuation
        ? { presentation: options.continuation.root }
        : {}),
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

  if (isRoleApprovalWait(result)) {
    if (!options.durableApproval)
      throw new Error("request_durable_approval_not_enabled");
    const continuation = Object.freeze({
      kind: "request_approval_continuation_v1" as const,
      ledger: captureRoleCallLedgerCheckpoint(ledger),
      root: result.root,
      callers: result.callers,
      preparedGroup: result.group,
    });
    validateRequestApprovalContinuation(
      continuation,
      ledger,
      request.workerCapabilities.provider.getDescriptors(),
    );
    await persistSettledSessionArtifactPaths({
      head: ledger.current(),
      sessionId: request.sessionId,
      trigger: "approval_wait",
      ...(options.persistArtifactPaths
        ? { persistArtifactPaths: options.persistArtifactPaths }
        : {}),
    });
    return Object.freeze({ kind: "awaiting_approval", continuation });
  }

  await persistSettledSessionArtifactPaths({
    head: ledger.current(),
    sessionId: request.sessionId,
    trigger: "root_succeeded",
    ...(options.persistArtifactPaths
      ? { persistArtifactPaths: options.persistArtifactPaths }
      : {}),
  });
  const delivered = deliverAnswer(request, result);
  if (options.durableApproval)
    return Object.freeze({ kind: "completed", result: delivered });
  return delivered;
}

function deliverAnswer(
  request: Pick<RequestExecutionScope, "onAnswerToken">,
  result: RequestRunnerResult,
): RequestRunnerResult {
  request.onAnswerToken(result.output);
  return result;
}
