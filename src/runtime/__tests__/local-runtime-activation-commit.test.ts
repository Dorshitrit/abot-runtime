import { afterEach, expect, test, vi } from "vitest";
import type { SessionRecord } from "../../sessions/types.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";

const fault = vi.hoisted(() => ({ directory: "", failures: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] === fault.directory && args[1] === "r") {
        fault.directory = "";
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          fault.failures++;
          throw new Error("injected_directory_sync_failure");
        });
      }
      return handle;
    },
  };
});
afterEach(() => {
  fault.directory = "";
  fault.failures = 0;
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

test("an uncertain initial activation is terminal before the live owner releases the request", async () => {
  const base = await createSchedulerRuntimeFixture("execution-agent-v1");
  await base.application.stop();
  const owner = await createLocalRuntimeOwner(base.config, {
    models: { invoke: base.invoke, invokeRaw: base.invokeRaw },
  });
  const peer = makeOwnerControlPeer("uncertain-start");
  const message = {
    type: "run_request",
    requestId: "uncertain",
    sessionId: "session",
    text: "Answer the current question.",
    toolPermissionMode: "ask",
    agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  };
  const options = { durableApprovals: true, approvalAvailable: true };
  try {
    fault.directory = base.config.paths.sessionsDir;
    await owner.call("request.run", [message, options], peer.peer);
    expect(fault.failures).toBe(1);
    expect(base.invoke).not.toHaveBeenCalled();
    expect(base.invokeRaw).not.toHaveBeenCalled();
    expect(
      await owner.call(
        "request.active",
        [message.requestId, message.sessionId],
        peer.peer,
      ),
    ).toBe(false);
    const session = (await owner.call(
      "sessions.getSessionById",
      ["session"],
      peer.peer,
    )) as SessionRecord;
    expect(
      session.requests?.find((request) => request.requestId === "uncertain"),
    ).toMatchObject({
      status: "failed",
      lifecycle: { terminalCause: "request_interrupted" },
    });
    expect(
      session.messages.filter(
        (entry) => entry.requestId === "uncertain" && entry.kind === "terminal",
      ),
    ).toHaveLength(1);
    expect(owner.isIdle?.()).toBe(true);
    // The same owner immediately accepts work in this session; no restart/recovery.
    await owner.call(
      "request.run",
      [{ ...message, requestId: "next" }, options],
      peer.peer,
    );
    const after = (await owner.call(
      "sessions.getSessionById",
      ["session"],
      peer.peer,
    )) as SessionRecord;
    expect(
      after.requests?.find((request) => request.requestId === "next")?.status,
    ).toBe("completed");
  } finally {
    await owner.stop();
    await owner.whenIdle?.();
    await base.dispose();
  }
});
