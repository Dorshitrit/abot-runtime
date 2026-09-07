import { expect, test, vi } from "vitest";
import { releaseRuntimeOwnerWhenIdle } from "../../local-host/owner-retirement.js";
import { createSchedulerTestGate } from "../support/scheduler-runtime-fixture.js";

test("retirement releases ownership only after the idle fence without blocking closure", async () => {
  const idle = createSchedulerTestGate();
  const release = vi.fn(async () => {});
  await releaseRuntimeOwnerWhenIdle(
    {
      call: async () => undefined,
      subscribe: () => () => {},
      stop: async () => {},
      whenIdle: () => idle.waiting,
    },
    release,
  );
  expect(release).not.toHaveBeenCalled();
  idle.open();
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
});

test("idle-fence failure retains the live owner's lease", async () => {
  const failure = new Error("idle_state_unknown");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const release = vi.fn(async () => {});
  try {
    await releaseRuntimeOwnerWhenIdle(
      {
        call: async () => undefined,
        subscribe: () => () => {},
        stop: async () => {},
        whenIdle: async () => {
          throw failure;
        },
      },
      release,
    );
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        "Local runtime owner retirement failed:",
        failure,
      ),
    );
    expect(release).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("an already-idle owner awaits the complete physical release", async () => {
  const releasing = createSchedulerTestGate();
  const released = createSchedulerTestGate();
  const release = vi.fn(async () => {
    releasing.open();
    await released.waiting;
  });
  let closed = false;
  const retirement = releaseRuntimeOwnerWhenIdle(
    {
      call: async () => undefined,
      subscribe: () => () => {},
      stop: async () => {},
      isIdle: () => true,
      whenIdle: async () => {},
    },
    release,
  ).then(() => {
    closed = true;
  });
  await releasing.waiting;
  expect(closed).toBe(false);
  released.open();
  await retirement;
  expect(closed).toBe(true);
  expect(release).toHaveBeenCalledOnce();
});
