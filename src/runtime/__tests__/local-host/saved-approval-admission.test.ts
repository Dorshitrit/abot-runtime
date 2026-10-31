import { SessionService } from "../../../sessions/session-service.js";
import { afterEach, expect, test, vi } from "vitest";
import type { RuntimeApplication, RuntimeRequestOptions } from "../../composition.js";
import type { LocalRequestControls } from "../../local-host/app-request-control.js";
import { LocalRuntimeOwnerActivity } from "../../local-host/owner-activity.js";
import { SavedRequestApprovals } from "../../local-host/saved-approvals.js";
import { SessionRequestAdmission } from "../../request/session-admission.js";
import { REQUEST_APPROVAL_SNAPSHOT } from "../../request/approval-wait/snapshot.js";
import * as preflight from "../../request/approval-wait/preflight.js";
import {
  accepted,
  fixture,
  waitExpected,
} from "../../../sessions/request-lifecycle/__tests__/support.js";
import { makeOwnerControlPeer } from "../support/local-runtime-owner-peer.js";
import { createSchedulerTestGate } from "../support/scheduler-runtime-fixture.js";

afterEach(() => vi.restoreAllMocks());

test("admission spans decision visibility, acknowledgement and resumed execution", async () => {
  const f = await fixture();
  const store = f.service.requestLifecycle;
  const continuation = await store.writeContinuation("conversation", {
    schema: REQUEST_APPROVAL_SNAPSHOT,
    version: 1,
    value: {
      originalPrompt: "Continue.",
      seed: {},
      runner: { preparedGroup: { entries: [] } },
    },
  });
  const waiting = accepted(
    await store.commitWait("conversation", { ...f.command, continuation }),
  );
  vi.spyOn(preflight, "validateApprovalResume").mockResolvedValue(undefined);
  const admission = new SessionRequestAdmission(
    () => false,
    async (id) => (await store.listWaiting(id)).length > 0,
  );
  const visible = createSchedulerTestGate();
  const acknowledge = createSchedulerTestGate();
  const execution = createSchedulerTestGate();
  const commit = store.commitDecision.bind(store);
  vi.spyOn(store, "commitDecision").mockImplementation(async (...args) => {
    const result = await commit(...args);
    visible.open();
    await acknowledge.waiting;
    return result;
  });
  const handle = vi.fn(async (_ws: unknown, _message: unknown, options: RuntimeRequestOptions) =>
    admission.run("conversation", () => execution.waiting, true, options.sessionAdmission),
  );
  const activity = new LocalRuntimeOwnerActivity();
  const saved = new SavedRequestApprovals(
    {
      services: {
        sessions: f.service,
        requestAdmission: admission,
        config: { runtimeId: "test" },
      },
      requests: { handle },
    } as unknown as RuntimeApplication,
    {
      ordinary: vi.fn(() => ({})),
      finish: vi.fn(),
    } as unknown as LocalRequestControls,
    activity,
    vi.fn(),
  );
  const command = {
    sessionId: "conversation",
    ...waitExpected(waiting.current),
    approvalId: "approval-1", commandId: "decision", approved: true,
  };
  const peer = makeOwnerControlPeer("decision").peer;
  const decision = saved.decide(command, peer);
  try {
    await visible.waiting;
    expect(await store.listWaiting("conversation")).toEqual([]);
    expect(await admission.tryReserveAvailable("conversation")).toBeNull();
    const releaseOther = await admission.tryReserveAvailable("other");
    expect(releaseOther).toBeTypeOf("function");
    releaseOther!();
    expect(handle).not.toHaveBeenCalled();
    const competing = vi.fn(async () => undefined);
    await expect(admission.run("conversation", competing)).rejects.toThrow("session_busy");
    expect(competing).not.toHaveBeenCalled();
    const duplicate = saved.decide(command, peer);
    const conflict = saved.decide({ ...command, approved: false }, peer);
    acknowledge.open();
    await expect(decision).resolves.toEqual({ accepted: true });
    await expect(duplicate).resolves.toEqual({ accepted: true, duplicate: true });
    await expect(conflict).resolves.toEqual({ accepted: false, reason: "approval_conflict" });
    expect(handle).toHaveBeenCalledOnce();
    await expect(admission.run("conversation", competing)).rejects.toThrow("session_busy");
    expect(competing).not.toHaveBeenCalled();
    expect(await admission.tryReserveAvailable("conversation")).toBeNull();
  } finally {
    acknowledge.open();
    execution.open();
    await decision;
    await activity.whenIdle();
  }
  const release = await admission.tryReserveAvailable("conversation");
  expect(release).toBeTypeOf("function");
  release!();
});

test("a partial approval waits for its original activation to retire before claiming admission", async () => {
  const f = await fixture(2);
  const store = f.service.requestLifecycle;
  const waiting = accepted(await store.commitWait("conversation", f.command));
  const admission = new SessionRequestAdmission(() => false, async (id) =>
    (await store.listWaiting(id)).length > 0);
  const handle = vi.fn();
  const saved = new SavedRequestApprovals({
    services: { sessions: f.service, requestAdmission: admission, config: { runtimeId: "test" } },
    requests: { handle },
  } as unknown as RuntimeApplication, {} as LocalRequestControls,
  new LocalRuntimeOwnerActivity(), vi.fn());
  const cleanup = createSchedulerTestGate();
  const retiring = saved.track("request", () =>
    admission.run("conversation", () => cleanup.waiting, true));
  const commit = vi.spyOn(store, "commitDecision");
  const readReceipt = vi.spyOn(store, "getDecisionReceipt");
  const decision = saved.decide({
    sessionId: "conversation", ...waitExpected(waiting.current),
    approvalId: "approval-1", commandId: "partial", approved: true,
  }, makeOwnerControlPeer("partial").peer);
  await vi.waitFor(() => expect(readReceipt).toHaveBeenCalledOnce());
  expect(commit).not.toHaveBeenCalled();
  cleanup.open();
  await retiring;
  await expect(decision).resolves.toEqual({ accepted: true });
  expect(handle).not.toHaveBeenCalled();
  expect(await saved.list("conversation")).toHaveLength(1);
});

test("a fresh owner reads saved ASK exclusion from disk and cancellation releases it", async () => {
  const f = await fixture();
  const waiting = accepted(await f.service.requestLifecycle.commitWait("conversation", f.command));
  const restarted = new SessionService({ sessionsDir: f.directory });
  const admission = new SessionRequestAdmission(() => false, async (id) =>
    (await restarted.requestLifecycle.listWaiting(id)).length > 0);
  const execute = vi.fn(async () => "next request");
  await expect(admission.run("conversation", execute)).rejects.toThrow("session_awaiting_approval");
  expect(execute).not.toHaveBeenCalled();
  expect(await admission.tryReserveAvailable("conversation")).toBeNull();
  accepted(await restarted.requestLifecycle.cancelWait("conversation", {
    expected: waitExpected(waiting.current), commandId: "cancel-saved",
    message: { content: "Stopped" },
  }));
  await expect(admission.run("conversation", execute)).resolves.toBe("next request");
});
