import { afterEach, expect, it, vi } from "vitest";
import type { SchedulerRunOutcome } from "../scheduler/contracts.js";
import {
  deferredCompletion,
  schedulerCompletionFixture,
} from "./support/scheduler-completion-fixture.js";

const fixtures: Awaited<ReturnType<typeof schedulerCompletionFixture>>[] = [];
async function fixture() {
  const value = await schedulerCompletionFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()));
});

it.each(["succeeded", "failed"] as const)(
  "reconciles a captured %s outcome after a failed write without rerunning it",
  async (status) => {
    const f = await fixture();
    const completion = deferredCompletion<SchedulerRunOutcome>();
    f.start.mockReturnValueOnce(completion.promise);
    const job = await f.create();
    f.failingSessions.add("session");
    f.advance();
    await f.service.tick();
    const [original] = await f.service.listRuns(job.id);
    f.advance(5_000);
    completion.resolve({
      status,
      resultText: "captured result",
      resultMessageId: "captured-message",
      error: status === "failed" ? "captured failure" : undefined,
    });
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    expect(f.onError).toHaveBeenCalledOnce();
    expect((await f.service.listRuns(job.id))[0].status).toBe("running");

    f.failingSessions.clear();
    f.advance();
    await f.service.tick();
    const runs = await f.service.listRuns(job.id);
    expect(runs[0]).toMatchObject({
      id: original.id,
      status,
      resultText: "captured result",
      resultMessageId: "captured-message",
      finishedAt: "2026-09-06T10:01:05.000Z",
    });
    expect(runs[0].error).toBe(
      status === "failed" ? "captured failure" : undefined,
    );
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.start.mock.calls[1][1].id).not.toBe(original.id);
    expect(
      f.start.mock.calls.filter(([, run]) => run.id === original.id),
    ).toHaveLength(1);
  },
);

it("attempts each retained write once per tick and does not starve another session", async () => {
  const f = await fixture();
  const broken = await f.create("broken");
  f.failingSessions.add("broken");
  f.advance();
  await f.service.tick();
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
  const [original] = await f.service.listRuns(broken.id);
  const healthy = await f.create("healthy");
  f.advance();
  await f.service.tick();
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(2));
  expect(f.start.mock.calls.map(([job]) => job.id)).toEqual([
    broken.id,
    healthy.id,
  ]);
  expect(
    f.terminalAttempts.mock.calls.filter(([id]) => id === original.id),
  ).toHaveLength(2);
  expect(
    (await f.service.listRuns(broken.id)).map((run) => run.status),
  ).toEqual(["running", "pending"]);
  expect((await f.service.listRuns(healthy.id))[0].status).toBe("succeeded");
  await f.service.tick();
  expect(
    f.terminalAttempts.mock.calls.filter(([id]) => id === original.id),
  ).toHaveLength(3);
  expect(f.start).toHaveBeenCalledTimes(2);
});

it.each(["pause", "cancel"] as const)(
  "preserves an already executed outcome after %s",
  async (operation) => {
    const f = await fixture();
    const job = await f.create();
    f.failingSessions.add("session");
    f.advance();
    await f.service.tick();
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    await f.service[operation](job.id);
    f.failingSessions.clear();
    await f.service.tick();
    expect((await f.service.listRuns(job.id))[0]).toMatchObject({
      status: "succeeded",
      resultText: "done",
    });
    expect((await f.service.get(job.id))?.state).toBe(
      operation === "pause" ? "paused" : "cancelled",
    );
    expect(f.start).toHaveBeenCalledOnce();
  },
);

it("honors session deletion while a reconciliation write is waiting", async () => {
  const f = await fixture();
  const job = await f.create();
  f.failingSessions.add("session");
  f.advance();
  await f.service.tick();
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
  f.failingSessions.clear();
  const barrier = f.holdNextUpdate();
  const ticking = f.service.tick();
  await barrier.entered;
  const deleting = f.service.deleteSession("session");
  barrier.resume();
  await ticking;
  await deleting;
  await f.service.tick();
  expect(f.terminalAttempts).toHaveBeenCalledOnce();
  expect(await f.service.get(job.id)).toBeNull();
  expect(await f.service.listRuns(job.id)).toEqual([]);
  expect(f.start).toHaveBeenCalledOnce();
});

it("drops retained results on stop and rejects reconciliation into the next generation", async () => {
  const f = await fixture();
  const job = await f.create();
  f.failingSessions.add("session");
  f.advance();
  await f.service.tick();
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
  f.failingSessions.clear();
  const barrier = f.holdNextUpdate();
  const ticking = f.service.tick();
  await barrier.entered;
  const stopping = f.service.stop();
  barrier.resume();
  await ticking;
  await stopping;
  await f.service.start();
  await f.service.tick();
  expect(f.terminalAttempts).toHaveBeenCalledOnce();
  expect((await f.service.listRuns(job.id))[0]).toMatchObject({
    status: "interrupted",
    error: "scheduler_process_stopped",
  });
  expect((await f.service.listRuns(job.id))[0].resultText).toBeUndefined();
  expect(f.start).toHaveBeenCalledOnce();
});
