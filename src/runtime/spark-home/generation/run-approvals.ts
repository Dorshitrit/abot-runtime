import type { ToolApprovalController, ToolApprovalDecision } from "../../ports.js";
import { homeGenerationFailure, type SparkHomeApprovalDecisionInput, type SparkHomePendingApproval } from "./contracts.js";

/** Owns live HOME consent only. The normal executor owns approval policy and exact calls. */
export function createSparkHomeRunApprovals(input: {
  runId: string; signal: AbortSignal;
  changed(approval: SparkHomePendingApproval | null): Promise<void>;
}) {
  let pending: { approvalId: string; complete(decision: ToolApprovalDecision): void } | undefined;
  const controller: ToolApprovalController = {
    async requestToolApproval(request, options) {
      input.signal.throwIfAborted();
      if (request.requestId !== input.runId) return homeGenerationFailure("spark_home_approval_identity_mismatch");
      if (pending) return homeGenerationFailure("spark_home_approval_already_pending");
      const signal = options?.abortSignal ? AbortSignal.any([input.signal, options.abortSignal]) : input.signal;
      let resolve!: (value: ToolApprovalDecision) => void;
      let reject!: (error: unknown) => void;
      const decision = new Promise<ToolApprovalDecision>((yes, no) => { resolve = yes; reject = no; });
      // A failed persistence update must not leave an unhandled pending rejection.
      void decision.catch(() => {});
      const abort = () => reject(signal.reason);
      const entry = { approvalId: request.approvalId, complete: resolve };
      pending = entry;
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        await input.changed({ approvalId: request.approvalId, tool: request.call.tool,
          summary: typeof request.meta?.intent === "string" ? request.meta.intent : "Review this read before it runs.",
          ...(request.meta ? { meta: structuredClone(request.meta) } : {}) });
        return await decision;
      } finally {
        signal.removeEventListener("abort", abort);
        if (pending === entry) pending = undefined;
        await input.changed(null);
      }
    },
  };
  return {
    controller,
    decide(decision: SparkHomeApprovalDecisionInput) {
      if (decision.runId !== input.runId) return homeGenerationFailure("spark_home_approval_not_pending");
      if (!pending || pending.approvalId !== decision.approvalId) return homeGenerationFailure("spark_home_approval_not_pending");
      input.signal.throwIfAborted();
      const accepted = pending;
      pending = undefined;
      accepted.complete({ approved: decision.approved, ...(decision.reason ? { reason: decision.reason } : {}) });
    },
  };
}
