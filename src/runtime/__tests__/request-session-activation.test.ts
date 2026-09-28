import { afterEach, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { SessionCommitOutcomeUnknownError } from "../../sessions/durable-session-commit.js";
import { fixture } from "../../sessions/request-lifecycle/__tests__/support.js";
import { openRequestSession } from "../session/request-session.js";
import type { RuntimeApplication } from "../composition.js";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import { LocalRuntimeOwnerActivity } from "../local-host/owner-activity.js";
import { SavedRequestApprovals } from "../local-host/saved-approvals.js";

afterEach(() => vi.restoreAllMocks());
const activation = {
  activationId: "initial-activation",
  ownerEpoch: "previous-owner",
};

test.each(["before", "after"] as const)(
  "failure %s activation commit cannot leave an orphan stream",
  async (boundary) => {
    const f = await fixture();
    const lifecycle = f.service.requestLifecycle;
    const start = lifecycle.startActivation.bind(lifecycle);
    const legacyStart = vi.spyOn(f.service, "startRequestStream");
    vi.spyOn(lifecycle, "startActivation").mockImplementationOnce(
      async (...args) => {
        if (boundary === "after") await start(...args);
        throw new Error("injected_start_failure");
      },
    );
    await expect(
      openRequestSession({
        sessionId: "new-session",
        requestId: "new-request",
        rawAttachments: undefined,
        sessionStore: f.service,
        activation,
      }),
    ).rejects.toThrow("injected_start_failure");
    expect(legacyStart).not.toHaveBeenCalled();
    const restarted = new SessionService({ sessionsDir: f.directory });
    const record = await restarted.getSessionById("new-session");
    if (boundary === "before") {
      expect(record?.requests ?? []).toEqual([]);
      return;
    }
    expect(record?.requests).toEqual([
      expect.objectContaining({
        status: "streaming",
        lifecycle: expect.objectContaining({ activation }),
      }),
    ]);
    const saved = new SavedRequestApprovals(
      { services: { sessions: restarted } } as unknown as RuntimeApplication,
      new LocalRequestControls(() => {}),
      new LocalRuntimeOwnerActivity(),
      () => {},
    );
    await saved.recover();
    expect(
      await restarted.requestLifecycle.get("new-session", "new-request"),
    ).toMatchObject({
      status: "failed",
      terminalCause: "request_interrupted",
    });
  },
);

test("new durable requests start with an activation while legacy clients keep stream startup", async () => {
  const f = await fixture();
  const legacyStart = vi.spyOn(f.service, "startRequestStream");
  const opened = await openRequestSession({
    sessionId: "conversation",
    requestId: "durable",
    rawAttachments: undefined,
    sessionStore: f.service,
    activation,
  });
  expect(opened.activation).toMatchObject({
    requestId: "durable",
    status: "streaming",
    activation,
  });
  expect(legacyStart).not.toHaveBeenCalled();
  const legacy = await openRequestSession({
    sessionId: "conversation",
    requestId: "legacy",
    rawAttachments: undefined,
    sessionStore: f.service,
  });
  expect(legacy.activation).toBeUndefined();
  expect(legacyStart).toHaveBeenCalledExactlyOnceWith("conversation", "legacy");
});

test.each(["activationId", "ownerEpoch"] as const)(
  "an uncertain start cannot interrupt a different %s",
  async (field) => {
    const f = await fixture();
    const before = await f.service.requestLifecycle.get(
      "conversation",
      "request",
    );
    const command = { ...before!.activation!, [field]: "different" };
    const error = new SessionCommitOutcomeUnknownError("conversation", {
      cause: new Error("sync_failed"),
    });
    vi.spyOn(
      f.service.requestLifecycle,
      "startActivation",
    ).mockRejectedValueOnce(error);
    const interrupt = vi.spyOn(
      f.service.requestLifecycle,
      "interruptActivation",
    );
    await expect(
      openRequestSession({
        sessionId: "conversation",
        requestId: "request",
        rawAttachments: undefined,
        sessionStore: f.service,
        activation: command,
      }),
    ).rejects.toBe(error);
    expect(interrupt).not.toHaveBeenCalled();
    expect(
      await f.service.requestLifecycle.get("conversation", "request"),
    ).toEqual(before);
  },
);
