import { afterEach, describe, expect, test } from "vitest";
import type { SchedulerService } from "../scheduler/contracts.js";
import type { SchedulerJobMutationGuard } from "../scheduler/job-mutation-guard.js";
import { schedulerGuardDeferred, schedulerGuardFixture } from "./support/scheduler-guard-fixture.js";

const services: SchedulerService[] = [];
async function fixture() {
  const result = await schedulerGuardFixture();
  services.push(result.service);
  return result;
}
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.stop())); });

function mutate(service: SchedulerService, action: string, id: string, guard: SchedulerJobMutationGuard) {
  if (action === "update") return service.update(id, { title: "Changed" }, guard);
  if (action === "run_now") return service.runNow(id, guard);
  return service[action as "pause" | "resume" | "cancel"](id, guard);
}

describe("atomic schedule mutation guards", () => {
  test.each(["update", "pause", "resume", "cancel", "run_now"])("%s rejects stale and foreign guards without changing Jobs or pending runs", async (action) => {
    const f = await fixture();
    await f.service.runNow(f.job.id);
    const before = f.snapshot();
    await expect(mutate(f.service, action, f.job.id, { sessionId: "session", expectedRevision: 0 }))
      .rejects.toThrow("scheduler_job_revision_conflict");
    await expect(mutate(f.service, action, f.job.id, { sessionId: "foreign", expectedRevision: f.job.revision }))
      .rejects.toThrow("scheduler_job_not_found");
    expect(f.snapshot()).toEqual(before);
    expect(f.start).not.toHaveBeenCalled();
  });

  test("run now rechecks its guard after awaited session validation", async () => {
    const f = await fixture();
    f.sessionExists.mockImplementationOnce(async () => {
      const changed = f.snapshot();
      changed.jobs[0]!.revision += 1;
      f.replaceSnapshot(changed);
      return true;
    });
    await expect(f.service.runNow(f.job.id, { sessionId: "session", expectedRevision: 1 }))
      .rejects.toThrow("scheduler_job_revision_conflict");
    expect(f.snapshot().runs).toEqual([]);
  });

  test("update checks the guard inside the mutation transaction", async () => {
    const f = await fixture();
    f.changeBeforeUpdate(async () => {
      f.changeBeforeUpdate();
      const changed = f.snapshot();
      changed.jobs[0]!.revision += 1;
      f.replaceSnapshot(changed);
    });
    await expect(f.service.update(f.job.id, { title: "Unauthorized stale edit" },
      { sessionId: "session", expectedRevision: 1 })).rejects.toThrow("scheduler_job_revision_conflict");
    expect((await f.service.get(f.job.id))?.title).toBe("Original");
  });

  test.each(["session_lookup", "claimed_run"])("a valid guarded edit blocks dispatch during %s", async (phase) => {
    const f = await fixture();
    await f.service.runNow(f.job.id);
    const entered = schedulerGuardDeferred();
    const release = schedulerGuardDeferred();
    const hold = async () => { entered.resolve(); await release.promise; };
    if (phase === "session_lookup") f.sessionExists.mockImplementationOnce(async () => { await hold(); return true; });
    if (phase === "claimed_run") f.holdClaim(hold);
    const tick = f.service.tick();
    await entered.promise;
    const edit = f.service.pause(f.job.id, { sessionId: "session", expectedRevision: 1 });
    release.resolve();
    await tick;
    await edit;
    expect(f.start).not.toHaveBeenCalled();
    expect((await f.service.get(f.job.id))?.state).toBe("paused");
    expect((await f.service.listRuns(f.job.id)).every((run) => run.status === "cancelled")).toBe(true);
  });

  test.each(["session_lookup", "claimed_run"])("a rejected guarded edit cannot interrupt %s", async (phase) => {
    const f = await fixture();
    await f.service.runNow(f.job.id);
    const entered = schedulerGuardDeferred();
    const release = schedulerGuardDeferred();
    const hold = async () => { entered.resolve(); await release.promise; };
    if (phase === "session_lookup") f.sessionExists.mockImplementationOnce(async () => { await hold(); return true; });
    if (phase === "claimed_run") f.holdClaim(hold);
    const tick = f.service.tick();
    await entered.promise;
    const rejected = expect(f.service.cancel(f.job.id, { sessionId: "session", expectedRevision: 0 }))
      .rejects.toThrow("scheduler_job_revision_conflict");
    release.resolve();
    await tick;
    await rejected;
    expect(f.start).toHaveBeenCalledOnce();
    expect((await f.service.get(f.job.id))?.state).toBe("active");
    expect((await f.service.listRuns(f.job.id)).some((run) => run.status === "cancelled")).toBe(false);
  });

  test("guarded edits bind the current Job revision when resume retained an older manual run", async () => {
    const f = await fixture();
    await f.service.pause(f.job.id);
    const pending = await f.service.runNow(f.job.id);
    const resumed = await f.service.resume(f.job.id);
    expect(pending.jobRevision).toBeLessThan(resumed.revision);
    const entered = schedulerGuardDeferred();
    const release = schedulerGuardDeferred();
    f.sessionExists.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return true; });
    const tick = f.service.tick();
    await entered.promise;
    const edit = f.service.update(f.job.id, { title: "Replacement" },
      { sessionId: "session", expectedRevision: resumed.revision });
    release.resolve();
    await tick;
    await edit;
    expect(f.start).not.toHaveBeenCalled();
    await f.service.tick();
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start.mock.calls[0]![0].title).toBe("Replacement");
  });

  test("guard reservations are released after success, no-op and validation failure", async () => {
    const f = await fixture();
    const guard = { sessionId: "session", expectedRevision: 1 };
    await f.service.update(f.job.id, {}, guard);
    await expect(f.service.update(f.job.id, { title: "" }, guard)).rejects.toThrow();
    await f.service.runNow(f.job.id, guard);
    await f.service.tick();
    expect(f.start).toHaveBeenCalledOnce();
  });
});
