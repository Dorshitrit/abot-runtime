import type { WorkerCapabilityExecutionFreshness } from "../../../orchestration/worker-capabilities/contracts.js";
import {
  STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION,
  STEERING_SUPERSEDED_SUMMARY,
} from "../../../orchestration/worker-capabilities/execution/execution-freshness.js";
import { rejectNormalInvocation } from "../shared/rejection.js";
import { requestNormalInvocationApproval } from "./approval.js";

export function workerDispatchRejection(
  freshness: WorkerCapabilityExecutionFreshness | undefined,
) {
  if (freshness?.token.kind !== "worker_steering_v1") return undefined;
  if (freshness.isCurrent()) return undefined;
  return rejectNormalInvocation(
    STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION,
    STEERING_SUPERSEDED_SUMMARY,
  );
}

export async function resolveApprovalBeforeWorkerDispatch(
  input: Parameters<typeof requestNormalInvocationApproval>[0],
  freshness?: WorkerCapabilityExecutionFreshness,
): ReturnType<typeof requestNormalInvocationApproval> {
  if (freshness?.token.kind !== "worker_steering_v1")
    return requestNormalInvocationApproval(input);
  input.abortSignal.throwIfAborted();
  const initial = workerDispatchRejection(freshness);
  if (initial) return { ok: false, rejection: initial };
  const waiting = new AbortController();
  const abort = () => waiting.abort(input.abortSignal.reason);
  input.abortSignal.addEventListener("abort", abort, { once: true });
  const unsubscribe =
    freshness.subscribe?.(() =>
      waiting.abort(new Error(STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION)),
    ) ?? (() => {});
  try {
    const result = await requestNormalInvocationApproval({
      ...input,
      abortSignal: waiting.signal,
    });
    input.abortSignal.throwIfAborted();
    const rejection = workerDispatchRejection(freshness);
    return rejection ? { ok: false, rejection } : result;
  } catch (error) {
    input.abortSignal.throwIfAborted();
    const rejection = workerDispatchRejection(freshness);
    if (!rejection) throw error;
    input.onEvent?.("tool.approval.rejected", {
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.preparedRequest
        ? { approvalId: input.preparedRequest.approvalId }
        : {}),
      tool: input.call.tool,
      reason: STEERING_SUPERSEDED_SUMMARY,
    });
    return { ok: false, rejection };
  } finally {
    unsubscribe();
    input.abortSignal.removeEventListener("abort", abort);
  }
}
