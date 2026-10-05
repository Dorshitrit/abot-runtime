import { expect, test, vi } from "vitest";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations/executor.js";
import type { RegisteredToolEffectPersistence } from "../adapters/registered-tool-normal-invocations/shared/contracts.js";
import { createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";
import { probeTools } from "./support/automation-agent-tool-fixture.js";

function fixture(effectPersistence?: RegisteredToolEffectPersistence) {
  const tools = probeTools("mutating");
  const controller = new AbortController();
  const onEvent = vi.fn();
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: tools.registry.listNormalInvocations!(),
    toolRegistry: tools.registry, requestId: "request", abortSignal: controller.signal,
    toolPermissionMode: "full_access", nextApprovalId: () => "approval", onEvent,
    ...(effectPersistence ? { effectPersistence } : {}),
  });
  const prepared = executor.prepare({ handle: executor.operations[0]!.handle, controls: {} });
  if (prepared.status !== "prepared") throw new Error(prepared.code);
  return { ...tools, controller, onEvent, prepared };
}

test("an abort after durable admission records a definite rejection and preserves the abort exception", async () => {
  const entered = createSchedulerTestGate();
  const resume = createSchedulerTestGate();
  const afterEffect = vi.fn<RegisteredToolEffectPersistence["afterEffect"]>(async () => undefined);
  const f = fixture({
    beforeEffect: async () => { entered.open(); await resume.waiting; return {}; },
    afterEffect,
  });
  const reason = new Error("automation_run_stopped");
  const running = f.prepared.execute("effect-1");
  const rejected = expect(running).rejects.toBe(reason);
  await entered.waiting;
  f.controller.abort(reason);
  resume.open();
  await rejected;
  expect(afterEffect).toHaveBeenCalledExactlyOnceWith({
    executionId: "effect-1", outcome: expect.objectContaining({
      status: "rejected", code: "request_aborted",
    }),
  });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.onEvent).not.toHaveBeenCalled();
});

test("failure to persist the abort receipt stays observable without dispatch", async () => {
  const failedReceipt = new Error("receipt_commit_failed");
  const f = fixture({
    beforeEffect: async () => { f.controller.abort(new Error("stopped")); return {}; },
    afterEffect: async () => { throw failedReceipt; },
  });
  await expect(f.prepared.execute("effect-1")).rejects.toBe(failedReceipt);
  expect(f.execute).not.toHaveBeenCalled();
});

test("an exception after dispatch still persists uncertainty", async () => {
  const afterEffect = vi.fn<RegisteredToolEffectPersistence["afterEffect"]>(async () => undefined);
  const f = fixture({ beforeEffect: async () => ({}), afterEffect });
  const failure = new Error("effect_failed");
  f.execute.mockRejectedValueOnce(failure);
  await expect(f.prepared.execute("effect-1")).rejects.toBe(failure);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(afterEffect).toHaveBeenCalledExactlyOnceWith({
    executionId: "effect-1", outcome: { status: "uncertain", error: "effect_failed" },
  });
});

test("an admission rejection has no settled effect receipt", async () => {
  const afterEffect = vi.fn<RegisteredToolEffectPersistence["afterEffect"]>(async () => undefined);
  const failure = new Error("admission_failed");
  const f = fixture({ beforeEffect: async () => { throw failure; }, afterEffect });
  await expect(f.prepared.execute("effect-1")).rejects.toBe(failure);
  expect(afterEffect).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});

test.each([false, true])("ordinary invocation parity when stopped=%s", async (stopped) => {
  const f = fixture();
  const reason = new Error("ordinary_stop");
  if (stopped) f.controller.abort(reason);
  const running = f.prepared.execute("ordinary-effect");
  if (stopped) {
    await expect(running).rejects.toBe(reason);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.onEvent).not.toHaveBeenCalled();
    return;
  }
  await expect(running).resolves.toMatchObject({ status: "executed", result: { ok: true } });
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual(["tool.started", "tool.completed"]);
});
