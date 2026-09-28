import { afterEach, expect, test, vi } from "vitest";
import type { RuntimeApplication } from "../../composition.js";
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
  const handle = vi.fn(async () =>
    admission.run("conversation", () => execution.waiting, true),
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
  const decision = saved.decide(
    {
      sessionId: "conversation",
      ...waitExpected(waiting.current),
      approvalId: "approval-1",
      commandId: "decision",
      approved: true,
    },
    makeOwnerControlPeer("decision").peer,
  );
  try {
    await visible.waiting;
    expect(await store.listWaiting("conversation")).toEqual([]);
    expect(await admission.tryReserveAvailable("conversation")).toBeNull();
    const releaseOther = await admission.tryReserveAvailable("other");
    expect(releaseOther).toBeTypeOf("function");
    releaseOther!();
    expect(handle).not.toHaveBeenCalled();
    acknowledge.open();
    await expect(decision).resolves.toEqual({ accepted: true });
    expect(handle).toHaveBeenCalledOnce();
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
