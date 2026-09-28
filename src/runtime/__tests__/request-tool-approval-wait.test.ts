import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type {
  ToolApprovalController,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../ports.js";
import { withToolApprovalWait } from "../request/tool-approval-wait.js";

const lifecycles: RequestLifecycle[] = [];
const request: ToolApprovalRequest = {
  requestId: "request",
  approvalId: "approval",
  call: { tool: "test", params: {} },
};

beforeEach(() => {
  vi.useFakeTimers();
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  for (const lifecycle of lifecycles.splice(0)) lifecycle.dispose();
  vi.useRealTimers();
  resetDebugLoggerConfig();
});

function createLifecycle(
  options: Omit<ConstructorParameters<typeof RequestLifecycle>[0], "requestId">,
): RequestLifecycle {
  const lifecycle = new RequestLifecycle({ requestId: "request", ...options });
  lifecycles.push(lifecycle);
  return lifecycle;
}

function approvalGate() {
  let decide!: (decision: ToolApprovalDecision) => void;
  const decision = new Promise<ToolApprovalDecision>((resolve) => {
    decide = resolve;
  });
  const requestToolApproval = vi.fn<
    ToolApprovalController["requestToolApproval"]
  >(() => decision);
  return { controller: { requestToolApproval }, decide };
}

test.each([
  {
    requestTimeoutMs: 1_000,
    inactivityTimeoutMs: 0,
    reason: "request_timeout",
    approved: true,
  },
  {
    requestTimeoutMs: 0,
    inactivityTimeoutMs: 1_000,
    reason: "request_inactivity_timeout",
    approved: false,
  },
])(
  "excludes human wait from $reason and resumes its remaining budget",
  async (input) => {
    const lifecycle = createLifecycle(input);
    await vi.advanceTimersByTimeAsync(200);
    const gate = approvalGate();
    const options = { abortSignal: lifecycle.signal };
    const controller = withToolApprovalWait(gate.controller, lifecycle);
    const settled = vi.fn();
    const pending = controller.requestToolApproval(request, options);
    void pending.then(settled);

    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(lifecycle.signal.aborted).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    expect(gate.controller.requestToolApproval).toHaveBeenCalledExactlyOnceWith(
      request,
      options,
    );

    const decision = { approved: input.approved };
    gate.decide(decision);
    await expect(pending).resolves.toBe(decision);
    await vi.advanceTimersByTimeAsync(799);
    expect(lifecycle.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.timedOutReason).toBe(input.reason);
  },
);

test("keeps both budgets suspended until every overlapping approval settles", async () => {
  const lifecycle = createLifecycle({
    requestTimeoutMs: 1_000,
    inactivityTimeoutMs: 2_000,
  });
  await vi.advanceTimersByTimeAsync(100);
  const first = approvalGate();
  const second = approvalGate();
  const firstWait = withToolApprovalWait(
    first.controller,
    lifecycle,
  ).requestToolApproval(request);
  const secondWait = withToolApprovalWait(
    second.controller,
    lifecycle,
  ).requestToolApproval({
    ...request,
    approvalId: "second",
  });
  await vi.advanceTimersByTimeAsync(5_000);
  first.decide({ approved: true });
  await firstWait;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(lifecycle.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);

  second.decide({ approved: false });
  await secondWait;
  await vi.advanceTimersByTimeAsync(899);
  expect(lifecycle.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(lifecycle.timedOutReason).toBe("request_timeout");
});

test("preserves consumed execution time across separate approval waits", async () => {
  const lifecycle = createLifecycle({
    requestTimeoutMs: 1_000,
    inactivityTimeoutMs: 0,
  });
  for (const activeTime of [100, 200]) {
    await vi.advanceTimersByTimeAsync(activeTime);
    const gate = approvalGate();
    const pending = withToolApprovalWait(
      gate.controller,
      lifecycle,
    ).requestToolApproval(request);
    await vi.advanceTimersByTimeAsync(10_000);
    gate.decide({ approved: true });
    await pending;
  }
  await vi.advanceTimersByTimeAsync(699);
  expect(lifecycle.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(lifecycle.timedOutReason).toBe("request_timeout");
});

test("progress refreshes inactivity allowance without ending an approval wait", async () => {
  const lifecycle = createLifecycle({
    requestTimeoutMs: 0,
    inactivityTimeoutMs: 1_000,
  });
  await vi.advanceTimersByTimeAsync(700);
  const gate = approvalGate();
  const pending = withToolApprovalWait(
    gate.controller,
    lifecycle,
  ).requestToolApproval(request);
  await vi.advanceTimersByTimeAsync(10_000);
  lifecycle.markProgress("accepted_tool_execution");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(lifecycle.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  gate.decide({ approved: true });
  await pending;
  await vi.advanceTimersByTimeAsync(999);
  expect(lifecycle.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(lifecycle.timedOutReason).toBe("request_inactivity_timeout");
});

test.each(["throw", "reject"] as const)(
  "releases the wait when the controller uses %s",
  async (failureMode) => {
    const lifecycle = createLifecycle({
      requestTimeoutMs: 1_000,
      inactivityTimeoutMs: 0,
    });
    await vi.advanceTimersByTimeAsync(400);
    const failure = new Error("approval unavailable");
    const controller = withToolApprovalWait(
      {
        requestToolApproval: () => {
          if (failureMode === "throw") throw failure;
          return Promise.reject(failure);
        },
      },
      lifecycle,
    );
    await expect(controller.requestToolApproval(request)).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(599);
    expect(lifecycle.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.timedOutReason).toBe("request_timeout");
  },
);

test("explicit cancellation remains effective and never rearms approval-wait timers", async () => {
  const external = new AbortController();
  const lifecycle = createLifecycle({
    requestTimeoutMs: 1_000,
    inactivityTimeoutMs: 500,
    abortSignal: external.signal,
  });
  const controller = withToolApprovalWait(
    {
      requestToolApproval: (_request, options) =>
        new Promise((resolve) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => resolve({ approved: false }),
            { once: true },
          );
        }),
    },
    lifecycle,
  );
  const pending = controller.requestToolApproval(request, {
    abortSignal: lifecycle.signal,
  });
  external.abort();
  await expect(pending).resolves.toEqual({ approved: false });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(lifecycle.signal.reason.message).toBe("request_cancelled");
  expect(lifecycle.timedOutReason).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test("settling after lifecycle disposal does not rearm either timer", async () => {
  const lifecycle = createLifecycle({
    requestTimeoutMs: 1_000,
    inactivityTimeoutMs: 500,
  });
  const gate = approvalGate();
  const pending = withToolApprovalWait(
    gate.controller,
    lifecycle,
  ).requestToolApproval(request);
  lifecycle.dispose();
  gate.decide({ approved: false });
  await pending;
  lifecycle.markProgress("valid_decision");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(lifecycle.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("disabled budgets remain disabled after approval", async () => {
  const lifecycle = createLifecycle({
    requestTimeoutMs: 0,
    inactivityTimeoutMs: 0,
  });
  const controller = withToolApprovalWait(
    { requestToolApproval: async () => ({ approved: true }) },
    lifecycle,
  );
  await controller.requestToolApproval(request);
  await vi.advanceTimersByTimeAsync(86_400_000);
  expect(lifecycle.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
