import { expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { REQUEST_STEERING_MESSAGE_KIND } from "../../request/request-steering.js";
import { createLocalRuntimeApplication } from "../../local-application.js";
import { createLocalRuntimeProcessFixture } from "../support/local-runtime-process-fixture.js";
import { createSchedulerTestGate, scheduledModelMessages } from "../support/scheduler-runtime-fixture.js";

function message(requestId: string, sessionId = "session") {
  return {
    type: "run_request" as const,
    requestId,
    sessionId,
    text: "Answer this request briefly.",
    agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" as const },
  };
}

test("managed clients share admission before acknowledgement and preserve independent sessions", async () => {
  const f = await createLocalRuntimeProcessFixture();
  const secondClient = createLocalRuntimeApplication(f.config);
  const accepting = createSchedulerTestGate();
  const accepted = createSchedulerTestGate();
  const firstAccepted = vi.fn(async () => {
    accepting.open();
    await accepted.waiting;
  });
  const rejectedAccepted = vi.fn();
  const otherAccepted = vi.fn();
  const events: Array<Record<string, unknown>> = [];
  const socket = { send: (data: string) => events.push(JSON.parse(data)) } as unknown as WebSocket;
  let first: Promise<unknown> | undefined;
  try {
    await secondClient.start();
    expect(f.observer.getOwnership()).toBe("client");
    expect(secondClient.getOwnership()).toBe("client");
    const before = await f.observer.services.sessions.getSessionById("session");
    first = f.observer.requests.handle(socket, message("winning-request"), {
      onAccepted: firstAccepted,
    });
    await accepting.waiting;
    await expect(secondClient.requests.handle(socket, message("rejected-request"), {
      onAccepted: rejectedAccepted,
    })).rejects.toThrow("session_busy");
    expect(firstAccepted).toHaveBeenCalledOnce();
    expect(rejectedAccepted).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(await f.observer.services.sessions.getSessionById("session")).toEqual(before);
    expect(await f.observer.services.sessions.getRequestReplayById("rejected-request", 0)).toBeNull();
    expect(events).toEqual([]);

    await secondClient.services.sessions.getOrCreateSession("independent");
    await secondClient.services.sessions.updateSessionTitle("independent", "Independent conversation");
    await secondClient.requests.handle(socket, message("independent-request", "independent"), {
      onAccepted: otherAccepted,
    });
    expect(otherAccepted).toHaveBeenCalledOnce();
    expect((await secondClient.services.sessions.getRequestReplayById("independent-request", 0))
      ?.finalState?.status).toBe("completed");
    expect(events.some((event) => event.requestId === "winning-request")).toBe(false);

    accepted.open();
    await first;
    expect((await f.observer.services.sessions.getRequestReplayById("winning-request", 0))
      ?.finalState?.status).toBe("completed");
    const laterAccepted = vi.fn();
    await secondClient.requests.handle(socket, message("later-request"), {
      onAccepted: laterAccepted,
    });
    expect(laterAccepted).toHaveBeenCalledOnce();
    expect((await secondClient.services.sessions.getRequestReplayById("later-request", 0))
      ?.finalState?.status).toBe("completed");
  } finally {
    accepted.open();
    await first?.catch(() => undefined);
    await secondClient.stop();
    await f.dispose();
  }
});


test("a busy session still accepts steering into its active request from another managed client", async () => {
  const entered = createSchedulerTestGate();
  const continueModel = createSchedulerTestGate();
  let firstModel = true;
  const f = await createLocalRuntimeProcessFixture(async () => {
    if (!firstModel) return;
    firstModel = false;
    entered.open();
    await continueModel.waiting;
  });
  const secondClient = createLocalRuntimeApplication(f.config);
  const socket = { send() {} } as unknown as WebSocket;
  const update = { steerId: "change-scope", text: "Include the revised scope in this answer." };
  let running: Promise<unknown> | undefined;
  try {
    await secondClient.start();
    running = f.observer.requests.handle(socket, message("steered-request"));
    await entered.waiting;
    await expect(secondClient.requests.handle(socket, message("rejected-follow-up")))
      .rejects.toThrow("session_busy");
    await expect(secondClient.requests.steer!("steered-request", update)).resolves.toEqual({
      ok: true, duplicate: false, update: { ...update, sequence: 1 },
    });
    await expect(secondClient.requests.steer!("steered-request", update)).resolves.toEqual({
      ok: true, duplicate: true, update: { ...update, sequence: 1 },
    });
    continueModel.open();
    await running;
    const steeringPayloads = f.invoke.mock.calls.flatMap(([input]) => scheduledModelMessages(input))
      .flatMap((entry) => {
        if (entry.role !== "user" || typeof entry.content !== "string") return [];
        try {
          const payload = JSON.parse(entry.content);
          return payload.kind === REQUEST_STEERING_MESSAGE_KIND ? [payload] : [];
        } catch { return []; }
      });
    expect(steeringPayloads).toContainEqual(expect.objectContaining({
      authority: "user", version: 1,
      updates: [{ sequence: 1, text: update.text }],
    }));
    const saved = await f.observer.services.sessions.getSessionById("session");
    expect(saved?.messages.filter((entry) => entry.content === update.text))
      .toEqual([expect.objectContaining({ role: "user", requestId: "steered-request" })]);
    expect(saved?.requests?.map((request) => request.requestId)).toEqual(["steered-request"]);
    expect((await f.observer.services.sessions.getRequestReplayById("steered-request", 0))
      ?.finalState?.status).toBe("completed");
    expect(await f.observer.services.sessions.getRequestReplayById("rejected-follow-up", 0)).toBeNull();
  } finally {
    continueModel.open();
    await running?.catch(() => undefined);
    await secondClient.stop();
    await f.dispose();
  }
});
