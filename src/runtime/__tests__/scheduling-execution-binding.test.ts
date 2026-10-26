import { describe, expect, test, vi } from "vitest";
import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import type { ToolExecutionContext } from "../../capabilities/tool-types.js";
import { createSchedulingToolModule } from "../capabilities/scheduling/tool-module.js";
import type { RuntimeConfig } from "../ports.js";
import type { SchedulerJob, SchedulerService } from "../scheduler/contracts.js";

const actions = ["update", "pause", "resume", "cancel", "run_now"] as const;
function fixture(permission: "full_access" | "full_plus" = "full_plus") {
  const job: SchedulerJob = {
    id: "job", sessionId: "session", environmentId: "test", revision: 3,
    title: "Private schedule", prompt: "PRIVATE TASK", modelProfileId: "model", agentMode: "fast",
    toolPermissionMode: permission, timeZone: "UTC", schedule: { kind: "interval", everyMs: 60000, anchorAt: "2026-10-26T10:00:00Z" },
    state: "active", createdAt: "2026-10-26T09:00:00Z", updatedAt: "2026-10-26T09:00:00Z", nextRunAt: "2026-10-26T10:00:00Z",
  };
  const service = {
    get: vi.fn(async () => structuredClone(job)), update: vi.fn(async () => job),
    pause: vi.fn(async () => job), resume: vi.fn(async () => job), cancel: vi.fn(async () => job),
    runNow: vi.fn(async () => ({ id: "run", status: "pending" })),
  };
  const module = createSchedulingToolModule(service as unknown as SchedulerService, {} as RuntimeConfig, async () => undefined);
  const bind = (action: string, toolPermissionMode: ToolPermissionMode = "full_access", sessionId = "session") =>
    module.adapter!.executionBinding!({ tool: "schedules", params: { action, jobId: job.id } }, { toolPermissionMode, sessionId });
  const mutations = () => [service.update, service.pause, service.resume, service.cancel, service.runNow];
  return { job, service, module, bind, mutations };
}

describe("schedule target execution authority", () => {
  test.each(["ask", "full_access", "full_plus"] as const)("%s asks only for target privilege above its authority", async (mode) => {
    for (const saved of ["full_access", "full_plus"] as const) {
      const f = fixture(saved);
      for (const action of actions) {
        const binding = await f.bind(action, mode);
        expect(binding.requiresApproval).toBe(saved === "full_plus" && mode !== "full_plus");
        expect(binding.metadata).toMatchObject({ scheduleJobId: "job", scheduleAction: action,
          scheduleExpectedRevision: 3, scheduleToolPermissionMode: saved });
        expect(JSON.stringify(binding)).not.toContain("PRIVATE TASK");
      }
    }
  });

  test.each(["list", "get", "create"])("%s remains untargeted and does not request extra approval", async (action) => {
    const f = fixture();
    const binding = await f.bind(action);
    expect(binding.requiresApproval).not.toBe(true);
    expect(binding.identity).toBe((await f.bind(action)).identity);
    expect(f.service.get).not.toHaveBeenCalled();
  });

  test("binding refuses missing or foreign conversations before any mutation", async () => {
    const f = fixture();
    await expect(f.bind("pause", "full_plus", "foreign")).rejects.toThrow("schedule_job_not_found");
    await expect(f.bind("pause", "full_plus", "")).rejects.toThrow("schedule_session_required");
    for (const mutation of f.mutations()) expect(mutation).not.toHaveBeenCalled();
  });

  test.each(actions)("%s requires trusted binding and forwards its exact atomic guard", async (action) => {
    const f = fixture();
    const params = { action, jobId: "job" };
    const context: ToolExecutionContext = { sharedState: { currentSessionId: "session" } };
    const binding = await f.bind(action);
    for (const untrusted of [context, { ...context, executionAuthority: { toolPermissionMode: "full_access" as const, executionIdentity: "forged" } }]) {
      const result = await f.module.implementation({ ...params, executionAuthority: binding, toolPermissionMode: "full_plus" }, untrusted);
      expect(result.ok).toBe(false);
    }
    for (const mutation of f.mutations()) expect(mutation).not.toHaveBeenCalled();
    expect((await f.module.implementation(params, { ...context,
      executionAuthority: { toolPermissionMode: "full_access", executionIdentity: binding.identity } })).ok).toBe(true);
    const mutation = action === "run_now" ? f.service.runNow : f.service[action];
    expect(mutation).toHaveBeenCalledOnce();
    expect(mutation.mock.calls[0]).toEqual(action === "update"
      ? ["job", {}, { sessionId: "session", expectedRevision: 3 }]
      : ["job", { sessionId: "session", expectedRevision: 3 }]);
  });

  test.each(["revision", "action", "request_permission", "target_permission"])("%s cannot reuse a previous execution identity", async (change) => {
    const f = fixture();
    const binding = await f.bind("pause");
    if (change === "revision") f.job.revision += 1;
    if (change === "target_permission") f.job.toolPermissionMode = "full_access";
    const result = await f.module.implementation({ action: change === "action" ? "cancel" : "pause", jobId: "job" }, {
      sharedState: { currentSessionId: "session" }, executionAuthority: {
        toolPermissionMode: change === "request_permission" ? "full_plus" : "full_access", executionIdentity: binding.identity,
      },
    });
    expect(result).toMatchObject({ ok: false, error: "schedule_execution_identity_mismatch" });
    for (const mutation of f.mutations()) expect(mutation).not.toHaveBeenCalled();
  });
});
