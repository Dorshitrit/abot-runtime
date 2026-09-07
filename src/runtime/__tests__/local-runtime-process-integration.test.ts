import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { SchedulerJob, SchedulerRun } from "../scheduler/contracts.js";
import {
  createLocalRuntimeProcessFixture,
  localRuntimeJobInput,
} from "./support/local-runtime-process-fixture.js";
import {
  createSchedulerTestGate,
  scheduledModelMessages,
  SCHEDULED_ANSWER,
  SCHEDULED_PROMPT,
} from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createLocalRuntimeProcessFixture>>;
const fixtures: Fixture[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  resetDebugLoggerConfig();
});

async function fixture(
  ...args: Parameters<typeof createLocalRuntimeProcessFixture>
) {
  const created = await createLocalRuntimeProcessFixture(...args);
  fixtures.push(created);
  return created;
}

async function waitForPending(
  fixture: Fixture,
  jobId: string,
): Promise<SchedulerRun> {
  let pending: SchedulerRun | undefined;
  await vi.waitFor(
    async () => {
      await fixture.observer.services.scheduler.tick();
      pending = (await fixture.observer.services.scheduler.listRuns()).find(
        (run) => run.jobId === jobId,
      );
      expect(pending?.status).toBe("pending");
    },
    { timeout: 5000, interval: 10 },
  );
  return pending!;
}

describe("local Runtime across separate processes", () => {
  test("a child manages the owner's schedules and receives one canonical run, then detaches without stopping the owner", async () => {
    const local = await fixture();
    const child = await local.child();
    expect(local.owner.ownership).toBe("owner");
    expect(local.observer.getOwnership()).toBe("client");
    expect(child.ready).toMatchObject({ ownership: "client" });
    expect(child.ready.pid).not.toBe(process.pid);
    const job = await child.call<SchedulerJob>(
      "createJob",
      localRuntimeJobInput(),
    );
    expect(await local.observer.services.scheduler.list()).toEqual([job]);
    expect(await child.call("listJobs")).toEqual([job]);
    const pending = await child.call<SchedulerRun>("runNow", job.id);
    await local.observer.services.scheduler.tick();
    const run = await local.waitForRun(pending.id);
    expect(run).toMatchObject({
      status: "succeeded",
      resultText: SCHEDULED_ANSWER,
      resultMessageId: expect.any(String),
    });
    const session =
      await local.observer.services.sessions.getSessionById("session");
    expect(
      session!.messages.filter(
        (message) => message.requestId === pending.requestId,
      ),
    ).toEqual([
      expect.objectContaining({
        role: "user",
        content: SCHEDULED_PROMPT,
        schedule: expect.objectContaining({ jobId: job.id, runId: pending.id }),
      }),
      expect.objectContaining({
        role: "assistant",
        content: SCHEDULED_ANSWER,
        id: run.resultMessageId,
      }),
    ]);
    const childSession = await child.call<{
      messages: { requestId?: string; content: string }[];
    }>("getSession", "session");
    expect(childSession.messages.map((message) => message.content)).toEqual(
      session!.messages.map((message) => message.content),
    );
    await vi.waitFor(() =>
      expect(
        child.events.filter(
          ({ event }) =>
            event.type === "completed" && event.requestId === pending.requestId,
        ),
      ).toHaveLength(1),
    );
    expect(
      local.events.filter(
        (event) =>
          event.name === "schedule.triggered" &&
          event.requestId === pending.requestId,
      ),
    ).toHaveLength(1);
    expect(
      child.events.filter(
        ({ event }) =>
          event.name === "schedule.triggered" &&
          event.requestId === pending.requestId,
      ),
    ).toHaveLength(1);
    await child.stop();
    const later = await local.observer.services.scheduler.runNow(job.id);
    await local.observer.services.scheduler.tick();
    expect((await local.waitForRun(later.id)).status).toBe("succeeded");
  }, 15_000);

  test("an ordinary request from another process blocks a due Job and contributes its settled answer to scheduled history", async () => {
    const entered = createSchedulerTestGate();
    const release = createSchedulerTestGate();
    releases.push(release.open);
    let firstDecision = true;
    const local = await fixture(async (input) => {
      if (input.modelStep !== "supervisor.decision" || !firstDecision) return;
      firstDecision = false;
      entered.open();
      await release.waiting;
    });
    const child = await local.child();
    const ordinary = child.call(
      "runRequest",
      "ordinary-from-child",
      "New information from the child process.",
    );
    await Promise.race([
      entered.waiting,
      ordinary.then(() => {
        throw new Error("ordinary_request_settled_before_model_gate");
      }),
    ]);
    const job = await child.call<SchedulerJob>("createJob", {
      ...localRuntimeJobInput(),
      schedule: { kind: "timer", delayMs: 1000 },
    });
    const pending = await waitForPending(local, job.id);
    expect(local.invoke).toHaveBeenCalledTimes(1);
    release.open();
    await ordinary;
    await local.observer.services.scheduler.tick();
    expect((await local.waitForRun(pending.id)).status).toBe("succeeded");
    const decisions = local.invoke.mock.calls.filter(
      ([input]) => input.modelStep === "supervisor.decision",
    );
    expect(decisions).toHaveLength(2);
    expect(JSON.stringify(scheduledModelMessages(decisions[1][0]))).toContain(
      "New information from the child process.",
    );
    expect(JSON.stringify(scheduledModelMessages(decisions[1][0]))).toContain(
      SCHEDULED_ANSWER,
    );
  }, 15_000);

  test.each(["delete", "cancel"] as const)(
    "%s from a child invalidates pending real dispatch at the single owner",
    async (action) => {
      const entered = createSchedulerTestGate();
      const release = createSchedulerTestGate();
      releases.push(release.open);
      let firstDecision = true;
      const local = await fixture(async (input) => {
        if (input.modelStep !== "supervisor.decision" || !firstDecision) return;
        firstDecision = false;
        entered.open();
        await release.waiting;
      });
      const child = await local.child();
      const ordinary = child
        .call(
          "runRequest",
          "ordinary-before-delete",
          "An already running ordinary request.",
        )
        .catch(() => undefined);
      await Promise.race([
        entered.waiting,
        ordinary.then(() => {
          throw new Error("ordinary_request_settled_before_model_gate");
        }),
      ]);
      const job = await child.call<SchedulerJob>("createJob", {
        ...localRuntimeJobInput(),
        schedule: { kind: "timer", delayMs: 1000 },
      });
      const pending = await waitForPending(local, job.id);
      if (action === "delete") await child.call("deleteSession", "session");
      if (action === "cancel") await child.call("cancelJob", job.id);
      release.open();
      await ordinary;
      await local.observer.services.scheduler.tick();
      expect(
        local.invoke.mock.calls.some(([input]) =>
          JSON.stringify(scheduledModelMessages(input)).includes(
            SCHEDULED_PROMPT,
          ),
        ),
      ).toBe(false);
      if (action === "cancel") {
        expect(await child.call("listJobs")).toEqual([
          expect.objectContaining({ id: job.id, state: "cancelled" }),
        ]);
        expect(await child.call("listRuns")).toEqual([
          expect.objectContaining({ id: pending.id, status: "cancelled" }),
        ]);
        expect(await child.call("getSession", "session")).not.toBeNull();
        return;
      }
      expect(await child.call("listJobs")).toEqual([]);
      expect(await child.call("listRuns")).toEqual([]);
      expect(await child.call("getSession", "session")).toBeNull();
      await expect(
        child.call("appendMessage", "session", "late write"),
      ).rejects.toThrow(/deleted/i);
      await expect(
        readFile(join(local.config.paths.sessionsDir, "session.json"), "utf-8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
    15_000,
  );

  test("deleting a session during an active scheduled response does not recreate it after the response settles", async () => {
    const entered = createSchedulerTestGate();
    const release = createSchedulerTestGate();
    releases.push(release.open);
    const local = await fixture(async (input) => {
      if (input.modelStep !== "supervisor.response") return;
      entered.open();
      await release.waiting;
    });
    const child = await local.child();
    const job = await child.call<SchedulerJob>(
      "createJob",
      localRuntimeJobInput(),
    );
    await child.call("runNow", job.id);
    await local.observer.services.scheduler.tick();
    await entered.waiting;
    await child.call("deleteSession", "session");
    release.open();
    await expect(
      child.call(
        "runRequest",
        "after-delete",
        "This must never invoke a model.",
      ),
    ).rejects.toThrow("session_deleted");
    expect(
      await local.observer.services.sessions.getSessionById("session"),
    ).toBeNull();
    expect(await child.call("listJobs")).toEqual([]);
    expect(await child.call("listRuns")).toEqual([]);
    expect(
      local.invoke.mock.calls.filter(
        ([input]) => input.modelStep === "supervisor.decision",
      ),
    ).toHaveLength(1);
    await expect(
      readFile(join(local.config.paths.sessionsDir, "session.json"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  test("different environment owners keep their Jobs, requests and model execution isolated", async () => {
    const first = await fixture(undefined, "first-environment");
    const second = await fixture(undefined, "second-environment");
    const firstChild = await first.child();
    const secondChild = await second.child();
    const firstJob = await firstChild.call<SchedulerJob>(
      "createJob",
      localRuntimeJobInput(),
    );
    const secondJob = await secondChild.call<SchedulerJob>(
      "createJob",
      localRuntimeJobInput(),
    );
    expect(firstJob.environmentId).toBe("first-environment");
    expect(secondJob.environmentId).toBe("second-environment");
    expect(await firstChild.call("listJobs")).toEqual([firstJob]);
    expect(await secondChild.call("listJobs")).toEqual([secondJob]);
    const pending = await firstChild.call<SchedulerRun>("runNow", firstJob.id);
    await first.observer.services.scheduler.tick();
    expect((await first.waitForRun(pending.id)).status).toBe("succeeded");
    expect(second.invoke).not.toHaveBeenCalled();
    expect(secondChild.events).toEqual([]);
    expect(await secondChild.call("listRuns")).toEqual([]);
  }, 20_000);
});
