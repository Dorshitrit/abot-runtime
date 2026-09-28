import { describe, expect, test, vi } from "vitest";
import { dispatchLocalLearningCall } from "../local-host/app-learning-dispatch.js";
import { createLocalLearningClient } from "../local-host/client-learning.js";
import type { PassiveLearningService } from "../passive-learning/contracts.js";

describe("learning local owner boundary", () => {
  test.each([
    "learning.accept",
    "learning.start",
    "learning.stop",
    "learning.flush",
    "learning.constructor",
    "learning.__proto__",
  ])("management RPC cannot call %s", (method) => {
    const service = {
      [method.split(".")[1]]: vi.fn(),
    } as unknown as PassiveLearningService;
    expect(() => dispatchLocalLearningCall(service, method, [])).toThrow(
      "local_runtime_method_unknown",
    );
  });

  test("client projects invalidations without changing collector lifecycle", async () => {
    const call = vi.fn(async () => null);
    const learning = createLocalLearningClient(call);
    const notify = vi.fn();
    const remove = learning.subscribe(notify);
    learning.receive({ type: "scheduled.event" });
    expect(notify).not.toHaveBeenCalled();
    learning.receive({ type: "learning.changed", content: "not forwarded" });
    expect(notify).toHaveBeenCalledExactlyOnceWith();
    expect(call).not.toHaveBeenCalled();
    await learning.service.configure({ enabled: false });
    expect(call).toHaveBeenCalledWith("learning.configure", [
      { enabled: false },
    ]);
    remove();
    learning.receive({ type: "learning.changed" });
    expect(notify).toHaveBeenCalledOnce();
  });

  test("client deletion uses only the dedicated no-argument RPC", async () => {
    const status = { pendingObservations: 0 };
    const call = vi.fn(async () => status);
    const learning = createLocalLearningClient(call);
    expect(await learning.service.clearPending()).toBe(status);
    expect(call).toHaveBeenCalledExactlyOnceWith("learning.clearPending", []);
  });

  test("permission recheck uses a no-argument owner call without changing preferences", async () => {
    const status = { collectionState: "starting", pendingObservations: 3 };
    const service = { restartCollection: vi.fn(async () => status), configure: vi.fn(), stop: vi.fn() } as unknown as PassiveLearningService;
    const call = vi.fn((method: string, args: readonly unknown[]) => dispatchLocalLearningCall(service, method, args));
    const client = createLocalLearningClient(call);
    expect(await client.service.restartCollection!()).toBe(status);
    expect(call).toHaveBeenCalledExactlyOnceWith("learning.restartCollection", []);
    expect(service.restartCollection).toHaveBeenCalledExactlyOnceWith();
    expect(service.configure).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(() => dispatchLocalLearningCall(service, "learning.restartCollection", [{ enabled: true }]))
      .toThrow("passive_learning_restart_collection_invalid");
    expect(() => dispatchLocalLearningCall({} as PassiveLearningService, "learning.restartCollection", []))
      .toThrow("passive_learning_unavailable");
  });

  test("owner dispatch clears pending without invoking collector lifecycle or configuration", async () => {
    const status = { pendingObservations: 0 };
    const service = {
      clearPending: vi.fn(async () => status),
      configure: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
    } as unknown as PassiveLearningService;
    expect(
      await dispatchLocalLearningCall(service, "learning.clearPending", []),
    ).toBe(status);
    expect(service.clearPending).toHaveBeenCalledExactlyOnceWith();
    expect(service.configure).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(() =>
      dispatchLocalLearningCall(service, "learning.clearPending", [
        { observations: [] },
      ]),
    ).toThrow("passive_learning_clear_pending_invalid");
    expect(service.clearPending).toHaveBeenCalledOnce();
  });
});
