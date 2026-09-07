import { afterEach, expect, test, vi } from "vitest";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import type { LocalRuntimePeer } from "../local-host/contracts.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { SessionStore } from "../ports.js";
import type { SchedulerJob, SchedulerRun } from "../scheduler/contracts.js";
import {
  createOwnerShutdownFixture,
  ordinaryOwnerRequest,
} from "./support/local-owner-shutdown-fixture.js";
import { localRuntimeJobInput } from "./support/local-runtime-process-fixture.js";
import { createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
type Session = NonNullable<Awaited<ReturnType<SessionStore["getSessionById"]>>>;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each(["ordinary", "scheduled"] as const)(
  "owner stop returns promptly and prevents replacement until the active %s request settles",
  async (kind) => {
    const fixture = await createOwnerShutdownFixture();
    cleanups.push(fixture.dispose);
    let pending: Promise<unknown> | undefined;
    if (kind === "ordinary") {
      pending = fixture.owner
        .call("request.run", [ordinaryOwnerRequest("active-request")])
        .catch((error: Error) => error.message);
    } else {
      const job = (await fixture.owner.call("scheduler.create", [
        localRuntimeJobInput(),
      ])) as SchedulerJob;
      await fixture.owner.call("scheduler.runNow", [job.id]);
      await fixture.owner.call("scheduler.tick");
    }
    await fixture.entered.waiting;
    const startedAt = Date.now();
    await fixture.owner.close();
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(fixture.connect(100)).rejects.toThrow(
      "local_runtime_owner_start_timeout",
    );
    fixture.completion.open();
    const replacement = await fixture.connect();
    expect(replacement.ownership).toBe("owner");
    const session = (await replacement.call("sessions.getSessionById", [
      "session",
    ])) as Session;
    expect(
      session.messages.some(
        (message) =>
          message.role === "assistant" && message.requestId !== undefined,
      ),
    ).toBe(true);
    if (kind === "scheduled") {
      const runs = (await replacement.call(
        "scheduler.listRuns",
      )) as SchedulerRun[];
      expect(runs).toMatchObject([{ status: "interrupted" }]);
    }
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    if (pending) expect(await pending).toBe("local_runtime_connection_lost");
  },
);

test("shutdown rejects an ordinary request queued behind scheduled work before it invokes the model", async () => {
  const fixture = await createOwnerShutdownFixture();
  cleanups.push(fixture.dispose);
  const job = (await fixture.owner.call("scheduler.create", [
    localRuntimeJobInput(),
  ])) as SchedulerJob;
  await fixture.owner.call("scheduler.runNow", [job.id]);
  await fixture.owner.call("scheduler.tick");
  await fixture.entered.waiting;
  const accepted = createSchedulerTestGate();
  fixture.owner.setClientHandler(async (method) => {
    if (method === "request.accepted") accepted.open();
  });
  const pending = fixture.owner
    .call("request.run", [ordinaryOwnerRequest("must-not-start")])
    .catch((error: Error) => error.message);
  await accepted.waiting;
  await fixture.owner.close();
  fixture.completion.open();
  const replacement = await fixture.connect();
  await pending;
  expect(fixture.invoke).toHaveBeenCalledTimes(2);
  const session = (await replacement.call("sessions.getSessionById", [
    "session",
  ])) as Session;
  expect(
    session.messages.some((message) => message.requestId === "must-not-start"),
  ).toBe(false);
});

test("a request awaiting the peer acceptance callback cannot start after owner shutdown", async () => {
  const fixture = await createOwnerShutdownFixture();
  cleanups.push(fixture.dispose);
  await fixture.owner.close();
  const owner = await createLocalRuntimeOwner(fixture.config, {
    models: { invoke: fixture.invoke, invokeRaw: fixture.invokeRaw },
  });
  cleanups.push(owner.stop);
  const accepted = createSchedulerTestGate();
  const peer: LocalRuntimePeer = {
    id: "waiting-peer",
    callClient: vi.fn(async () => accepted.waiting),
    onClose: () => () => {},
  };
  const pending = owner.call(
    "request.run",
    [ordinaryOwnerRequest("late")],
    peer,
  );
  const settled = pending.catch((error: Error) => error.message);
  const shutdown = owner.stop();
  expect(owner.stop()).toBe(shutdown);
  await shutdown;
  accepted.open();
  fixture.completion.open();
  expect(await settled).toBe("local_runtime_owner_stopped");
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test("a disconnected memory write retains ownership until its effect actually settles", async () => {
  const entered = createSchedulerTestGate();
  const completed = createSchedulerTestGate();
  const written = vi.fn();
  const fixture = await createOwnerShutdownFixture({
    longTermMemory: {
      clear: async () => {
        entered.open();
        await completed.waiting;
        written();
        return { deletedCount: 1 };
      },
    } as unknown as LongTermMemoryService,
  });
  cleanups.push(fixture.dispose);
  cleanups.push(async () => completed.open());
  const pending = fixture.owner.call("memory.clear").catch(() => undefined);
  await entered.waiting;
  await fixture.owner.close();
  await expect(fixture.connect(100)).rejects.toThrow(
    "local_runtime_owner_start_timeout",
  );
  expect(written).not.toHaveBeenCalled();
  completed.open();
  expect((await fixture.connect()).ownership).toBe("owner");
  expect(written).toHaveBeenCalledOnce();
  await pending;
});
