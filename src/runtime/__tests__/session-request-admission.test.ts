import { describe, expect, test, vi } from "vitest";
import { SessionRequestAdmission, type SessionRequestAdmissionClaim } from "../request/session-admission.js";

function createGate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waiting, open };
}

describe("shared session request admission", () => {
  test("claims the session before reading saved approvals and rejects competing work", async () => {
    const checking = createGate();
    const checked = createGate();
    const hasSavedWait = vi.fn(async () => {
      checking.open();
      await checked.waiting;
      return false;
    });
    const admission = new SessionRequestAdmission(() => false, hasSavedWait);
    const execute = vi.fn(async () => "admitted");
    const competing = vi.fn(async () => "must not execute");
    const running = admission.run("session", execute);
    await checking.waiting;
    expect(admission.tryReserve("session")).toBeNull();
    await expect(admission.run("session", competing)).rejects.toThrow("session_busy");
    expect(hasSavedWait).toHaveBeenCalledOnce();
    expect(competing).not.toHaveBeenCalled();
    checked.open();
    await expect(running).resolves.toBe("admitted");
    expect(execute).toHaveBeenCalledOnce();
  });

  test("checks saved waits under a reservation and releases it on blocked or failed reads", async () => {
    const checking = createGate();
    const checked = createGate();
    const admission = new SessionRequestAdmission(() => false, async () => {
      checking.open();
      await checked.waiting;
      return true;
    });
    const reservation = admission.tryReserveAvailable("session");
    await checking.waiting;
    const execute = vi.fn(async () => undefined);
    const ordinary = admission.run("session", execute);
    const rejected = expect(ordinary).rejects.toThrow("session_awaiting_approval");
    expect(execute).not.toHaveBeenCalled();
    expect(admission.tryReserve("session")).toBeNull();
    checked.open();
    await expect(reservation).resolves.toBeNull();
    await rejected;
    expect(admission.isIdle()).toBe(true);
    const failed = new SessionRequestAdmission(() => false, async () => {
      throw new Error("storage_failed");
    });
    await expect(failed.tryReserveAvailable("session")).rejects.toThrow("storage_failed");
    expect(failed.isIdle()).toBe(true);
  });

  test.each(["close", "delete"])("a reservation cannot survive %s during its saved-state read", async (change) => {
    const checking = createGate();
    const checked = createGate();
    let deleted = false;
    const admission = new SessionRequestAdmission(() => deleted, async () => {
      checking.open();
      await checked.waiting;
      return false;
    });
    const reservation = admission.tryReserveAvailable("session");
    await checking.waiting;
    if (change === "close") admission.close();
    if (change === "delete") deleted = true;
    checked.open();
    await expect(reservation).resolves.toBeNull();
    expect(admission.isIdle()).toBe(true);
  });

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

  test("rejects a competing session request while other sessions run concurrently", async () => {
    const admission = new SessionRequestAdmission(() => false);
    const first = createGate();
    const other = createGate();
    const executeFirst = vi.fn(() => first.waiting);
    const executeSecond = vi.fn(async () => "must not execute");
    const executeOther = vi.fn(() => other.waiting);
    const firstRun = admission.run("session", executeFirst);
    const otherRun = admission.run("other", executeOther);
    await expect(admission.run("session", executeSecond)).rejects.toThrow("session_busy");
    expect(executeFirst).toHaveBeenCalledOnce();
    expect(executeSecond).not.toHaveBeenCalled();
    expect(executeOther).toHaveBeenCalledOnce();
    expect(admission.tryReserve("session")).toBeNull();
    first.open();
    await firstRun;
    const release = admission.tryReserve("session");
    expect(release).toBeTypeOf("function");
    release!();
    other.open();
    await otherRun;
  });

  test("only an exact claim may span the handoff to a saved request's resumed runner", async () => {
    const admission = new SessionRequestAdmission(() => false);
    const execution = createGate();
    let resumed!: Promise<void>;
    let claimed!: SessionRequestAdmissionClaim;
    await admission.run("session", async (claim) => {
      claimed = claim;
      resumed = admission.run("session", () => execution.waiting, true, claim);
    }, true);
    const competing = vi.fn(async () => undefined);
    await expect(admission.run("session", competing, true)).rejects.toThrow("session_busy");
    await expect(admission.run("session", competing, true, { sessionId: "session" })).rejects.toThrow("session_admission_claim_invalid");
    expect(admission.tryReserve("session")).toBeNull();
    execution.open();
    await resumed;
    await expect(admission.run("session", competing, true, claimed)).rejects.toThrow("session_admission_claim_invalid");
    await admission.run("session", competing);
    expect(competing).toHaveBeenCalledOnce();
  });

  test("saved waits still exclude fresh requests after a new admission owner starts", async () => {
    let waiting = true;
    const admission = new SessionRequestAdmission(() => false, async () => waiting);
    const execute = vi.fn(async () => "next request");
    await expect(admission.run("session", execute)).rejects.toThrow("session_awaiting_approval");
    expect(execute).not.toHaveBeenCalled();
    waiting = false;
    await expect(admission.run("session", execute)).resolves.toBe("next request");
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
