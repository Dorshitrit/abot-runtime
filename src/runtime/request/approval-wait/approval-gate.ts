import type {
  CapabilityApprovalGate,
  BoundApprovalDecision,
  PreparedApprovalGroup,
} from "../../orchestration/worker-capabilities/approval-contracts.js";
import type { RequestToolResources } from "../../capabilities/request-tool-resources.js";
import type { ToolApprovalController } from "../../ports.js";

const WAIT_PARKED = "approval_wait_parked";

export function createRequestApprovalGate(params: {
  resources: RequestToolResources;
  controller?: ToolApprovalController;
  signal: AbortSignal;
  onEvent(name: string, payload: Record<string, unknown>): void;
}): CapabilityApprovalGate {
  return {
    async resolve(group) {
      params.signal.throwIfAborted();
      if (!params.resources.hasActiveWork())
        return { kind: "awaiting_approval" };
      return resolveWhileWorkIsActive(group, params);
    },
  };
}

async function resolveWhileWorkIsActive(
  group: PreparedApprovalGroup,
  params: Parameters<typeof createRequestApprovalGate>[0],
): ReturnType<CapabilityApprovalGate["resolve"]> {
  const controller = params.controller;
  if (!controller) throw new Error("tool_approval_unavailable");
  const waiting = new AbortController();
  const abort = () => waiting.abort(params.signal.reason);
  params.signal.addEventListener("abort", abort, { once: true });
  if (params.signal.aborted) abort();
  const decisions: BoundApprovalDecision[] = [
    ...(group.initialDecisions ?? []),
  ];
  const received = new Set(decisions.map((entry) => entry.approvalId));
  const entries = group.entries.filter(
    (entry) =>
      entry.approvalRequest && !received.has(entry.approvalRequest.approvalId),
  );
  const tasks = entries.map(async (entry) => {
    const request = entry.approvalRequest!;
    params.onEvent("tool.approval.required", {
      approvalId: request.approvalId,
      executionId: entry.executionId,
      tool: request.call.tool,
      ...(request.meta ? { meta: request.meta } : {}),
    });
    const decision = await controller.requestToolApproval(request, {
      abortSignal: waiting.signal,
    });
    if (waiting.signal.aborted) return;
    decisions.push({
      approvalId: request.approvalId,
      actionFingerprint: entry.actionFingerprint,
      decision,
    });
  });
  const allDecided = Promise.all(tasks).then(() => "decided" as const);
  const quiescent = params.resources
    .waitForQuiescence(waiting.signal)
    .then(() => "quiescent" as const);
  try {
    const result = await Promise.race([allDecided, quiescent]);
    params.signal.throwIfAborted();
    if (result === "decided") return { kind: "decisions", decisions };
    if (
      decisions.length ===
      group.entries.filter((entry) => entry.approvalRequest).length
    ) {
      return { kind: "decisions", decisions };
    }
    return { kind: "awaiting_approval", decisions };
  } finally {
    waiting.abort(new Error(WAIT_PARKED));
    params.signal.removeEventListener("abort", abort);
    await Promise.allSettled([...tasks, quiescent]);
  }
}
