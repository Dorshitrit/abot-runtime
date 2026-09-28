import { expect, test, vi } from "vitest";
import { acquireHostScheduler } from "../runtime-host-scheduler-ownership.js";
import { startRuntimeHostLifecycle } from "../runtime-host-lifecycle.js";
import type { RuntimeEnvironmentServices } from "../composition.js";

test("shared host handles retain one learning lifecycle until the last handle closes", async () => {
  const learning = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const retention = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const services = {
    scheduler: {},
    startScheduler: vi.fn(async () => {}),
    stopScheduler: vi.fn(async () => {}),
    passiveLearning: learning,
    longTermMemory: { retention },
  } as unknown as RuntimeEnvironmentServices;
  const first = acquireHostScheduler(services);
  const second = acquireHostScheduler({ ...services });
  await Promise.all([first.ready, second.ready]);
  expect(learning.start).toHaveBeenCalledOnce();
  expect(retention.start).toHaveBeenCalledOnce();
  await first.release();
  expect(learning.stop).not.toHaveBeenCalled();
  expect(retention.stop).not.toHaveBeenCalled();
  await second.release();
  expect(learning.stop).toHaveBeenCalledOnce();
  expect(retention.stop).toHaveBeenCalledOnce();
  const restarted = acquireHostScheduler(services);
  await restarted.ready;
  expect(learning.start).toHaveBeenCalledTimes(2);
  expect(retention.start).toHaveBeenCalledTimes(2);
  await restarted.release();
});

test.each([false, true])(
  "pending scheduler startup only starts learning for a remaining host (sibling=%s)",
  async (keepSibling) => {
    let finishStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const learning = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const services = {
      scheduler: {},
      startScheduler: vi.fn(() => startup),
      stopScheduler: vi.fn(async () => {}),
      passiveLearning: learning,
    } as unknown as RuntimeEnvironmentServices;
    const open = () =>
      startRuntimeHostLifecycle(services, undefined, () => ({
        stop: async () => {},
      }));
    const first = open();
    const sibling = keepSibling ? open() : undefined;
    await first.stop();
    expect(learning.start).not.toHaveBeenCalled();
    finishStartup();
    await expect(first.ready).rejects.toThrow("runtime_host_stopped");
    await sibling?.ready;
    expect(learning.start).toHaveBeenCalledTimes(keepSibling ? 1 : 0);
    await sibling?.stop();
    expect(learning.stop).toHaveBeenCalledOnce();
  },
);
