import { describe, expect, test, vi } from "vitest";
import { SessionRequestAdmission } from "../request/session-admission.js";

function createGate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waiting, open };
}

describe("shared session request admission", () => {
  test("closing admission rejects queued work immediately while idle waits for actual reservations and requests", async () => {
    const admission = new SessionRequestAdmission(() => false);
    const release = admission.tryReserve("scheduled")!;
    const completion = createGate();
    const running = admission.run("ordinary", () => completion.waiting);
    const execute = vi.fn(async () => "must not execute");
    const queued = admission.run("scheduled", execute);
    const rejected = expect(queued).rejects.toThrow(
      "runtime_request_admission_closed",
    );
    admission.close();
    await rejected;
    expect(execute).not.toHaveBeenCalled();
    expect(admission.tryReserve("another")).toBeNull();
    await expect(admission.run("another", execute)).rejects.toThrow(
      "runtime_request_admission_closed",
    );
    const idle = vi.fn();
    const waiting = admission.whenIdle().then(idle);
    completion.open();
    await running;
    expect(idle).not.toHaveBeenCalled();
    release();
    await waiting;
    expect(idle).toHaveBeenCalledOnce();
  });

  test("preserves concurrent ordinary requests and reserves only when all finish", async () => {
    const admission = new SessionRequestAdmission(() => false);
    const first = createGate();
    const second = createGate();
    const executeFirst = vi.fn(() => first.waiting);
    const executeSecond = vi.fn(() => second.waiting);
    const firstRun = admission.run("session", executeFirst);
    const secondRun = admission.run("session", executeSecond);
    expect(executeFirst).toHaveBeenCalledOnce();
    expect(executeSecond).toHaveBeenCalledOnce();
    expect(admission.tryReserve("session")).toBeNull();
    first.open();
    await firstRun;
    expect(admission.tryReserve("session")).toBeNull();
    second.open();
    await secondRun;
    const release = admission.tryReserve("session");
    expect(release).toBeTypeOf("function");
    expect(admission.tryReserve("session")).toBeNull();
    release!();
  });

  test("ordinary requests arriving during a scheduled reservation wait while other sessions proceed", async () => {
    const admission = new SessionRequestAdmission(() => false);
    const release = admission.tryReserve("session")!;
    const execute = vi.fn(async () => "ordinary result");
    const queued = admission.run("session", execute);
    expect(execute).not.toHaveBeenCalled();
    await expect(
      admission.run("other", async () => "independent"),
    ).resolves.toBe("independent");
    expect(execute).not.toHaveBeenCalled();
    release();
    await expect(queued).resolves.toBe("ordinary result");
    expect(execute).toHaveBeenCalledOnce();
  });

  test("checks deletion before reserving or starting and rechecks a queued request after release", async () => {
    const deleted = new Set<string>();
    const admission = new SessionRequestAdmission((id) => deleted.has(id));
    const release = admission.tryReserve("session")!;
    const execute = vi.fn(async () => "must not execute");
    const queued = admission.run("session", execute);
    const queuedResult = Promise.allSettled([queued]);
    deleted.add("session");
    expect(admission.tryReserve("session")).toBeNull();
    release();
    expect((await queuedResult)[0]).toMatchObject({
      status: "rejected",
      reason: { message: "session_deleted" },
    });
    await expect(admission.run("session", execute)).rejects.toThrow(
      "session_deleted",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test("allows an already-started request to finish after deletion but never admits a later one", async () => {
    let deleted = false;
    const admission = new SessionRequestAdmission(() => deleted);
    const completion = createGate();
    const running = admission.run("session", async () => {
      await completion.waiting;
      return "finished";
    });
    deleted = true;
    completion.open();
    await expect(running).resolves.toBe("finished");
    expect(admission.tryReserve("session")).toBeNull();
    const later = vi.fn(async () => "must not execute");
    await expect(admission.run("session", later)).rejects.toThrow(
      "session_deleted",
    );
    expect(later).not.toHaveBeenCalled();
  });

  test("releases ordinary activity after rejection and makes reservation release idempotent", async () => {
    const admission = new SessionRequestAdmission(() => false);
    await expect(
      admission.run("session", async () => {
        throw new Error("request_failed");
      }),
    ).rejects.toThrow("request_failed");
    const firstRelease = admission.tryReserve("session")!;
    firstRelease();
    const secondRelease = admission.tryReserve("session")!;
    firstRelease();
    expect(admission.tryReserve("session")).toBeNull();
    secondRelease();
    const nextRelease = admission.tryReserve("session");
    expect(nextRelease).toBeTypeOf("function");
    nextRelease!();
  });
});
