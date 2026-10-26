import { afterEach, describe, expect, test, vi } from "vitest";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createSchedulingToolModule } from "../capabilities/scheduling/tool-module.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import type { RuntimeConfig, ToolApprovalController, ToolPermissionMode } from "../ports.js";
import type { SchedulerService } from "../scheduler/contracts.js";
import { schedulerGuardFixture } from "./support/scheduler-guard-fixture.js";

const services: SchedulerService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.stop())); });
const modes = ["ask", "full_access", "full_plus"] as const;
const savedModes = ["full_access", "full_plus"] as const;
const actions = ["update", "pause", "resume", "cancel", "run_now"] as const;
const matrix = modes.flatMap((mode) => savedModes.flatMap((saved) => actions.map((action) => ({ mode, saved, action }))));
const approvalRequired = (mode: ToolPermissionMode, saved: string) => mode === "ask" || (mode === "full_access" && saved === "full_plus");

async function harness(
  mode: ToolPermissionMode,
  saved: "full_access" | "full_plus",
  action: typeof actions[number],
  decision: "approve" | "deny" | "missing" = "approve",
) {
  const f = await schedulerGuardFixture();
  services.push(f.service);
  await f.service.update(f.job.id, { toolPermissionMode: saved });
  const mutation = vi.spyOn(f.service, action === "run_now" ? "runNow" : action);
  const module = createSchedulingToolModule(f.service, {} as RuntimeConfig, async () => undefined);
  const registry = createConfiguredToolRegistry(undefined, [module]);
  const requestToolApproval = vi.fn<ToolApprovalController["requestToolApproval"]>(async () => ({ approved: decision === "approve" }));
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: registry.listNormalInvocations!(), toolRegistry: registry,
    requestId: "schedule-approval", abortSignal: new AbortController().signal,
    toolPermissionMode: mode, sharedState: { currentSessionId: "session" },
    nextApprovalId: () => "approval",
    ...(decision === "missing" ? {} : { toolApprovalController: { requestToolApproval } }),
  });
  const operation = executor.operations.find((candidate) => candidate.operation.operationId === action)!;
  const prepared = await executor.prepare({ handle: operation.handle,
    controls: { jobId: f.job.id, ...(action === "update" ? { title: "Changed" } : {}) } });
  if (prepared.status !== "prepared") throw new Error(JSON.stringify(prepared));
  return { ...f, mutation, prepared, executor, requestToolApproval };
}

describe("Schedules with canonical tool approval", () => {
  test.each(matrix)("$mode request against $saved Job: $action", async ({ mode, saved, action }) => {
    const f = await harness(mode, saved, action);
    const required = approvalRequired(mode, saved);
    expect(Boolean(f.prepared.approvalRequest)).toBe(required);
    expect(f.mutation).not.toHaveBeenCalled();
    expect(await f.prepared.execute()).toMatchObject({ status: "executed", result: { ok: true } });
    expect(f.requestToolApproval).toHaveBeenCalledTimes(required ? 1 : 0);
    expect(f.mutation).toHaveBeenCalledOnce();
    if (required) expect(f.requestToolApproval.mock.calls[0]![0].meta).toMatchObject({
      scheduleJobId: f.job.id, scheduleToolPermissionMode: saved, scheduleAction: action,
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  test.each(matrix.filter(({ mode, saved }) => approvalRequired(mode, saved)))
    ("$mode to $saved $action has no effects without approval", async ({ mode, saved, action }) => {
      for (const decision of ["deny", "missing"] as const) {
        const f = await harness(mode, saved, action, decision);
        const before = f.snapshot();
        expect(await f.prepared.execute()).toMatchObject({ status: "rejected",
          code: decision === "deny" ? "tool_approval_rejected" : "tool_approval_unavailable" });
        expect(f.mutation).not.toHaveBeenCalled();
        expect(f.snapshot()).toEqual(before);
        expect(f.start).not.toHaveBeenCalled();
      }
    });

  test.each(matrix.filter(({ mode, saved }) => !approvalRequired(mode, saved)))
    ("$mode to $saved $action remains executable without an approval controller", async ({ mode, saved, action }) => {
      const f = await harness(mode, saved, action, "missing");
      expect(await f.prepared.execute()).toMatchObject({ status: "executed", result: { ok: true } });
      expect(f.mutation).toHaveBeenCalledOnce();
    });

  test("restored preparation preserves the exact approval and target authority", async () => {
    const f = await harness("full_access", "full_plus", "pause");
    const restored = await f.executor.restore(f.prepared.snapshot);
    if (restored.status !== "prepared") throw new Error(JSON.stringify(restored));
    expect(restored.approvalRequest).toEqual(f.prepared.approvalRequest);
    expect(await restored.execute()).toMatchObject({ status: "executed", result: { ok: true } });
    expect(f.requestToolApproval).toHaveBeenCalledOnce();
    expect(f.mutation).toHaveBeenCalledOnce();
  });

  test("approval cannot authorize a target revision changed while waiting", async () => {
    const f = await harness("full_access", "full_plus", "pause");
    f.requestToolApproval.mockImplementationOnce(async () => {
      await f.service.update(f.job.id, { title: "New revision" });
      return { approved: true };
    });
    const result = await f.prepared.execute();
    expect(result).not.toMatchObject({ status: "executed", result: { ok: true } });
    expect(f.mutation).not.toHaveBeenCalled();
    expect((await f.service.get(f.job.id))?.state).toBe("active");
  });
});
