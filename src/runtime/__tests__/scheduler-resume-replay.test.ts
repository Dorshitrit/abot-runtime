import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import type { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { LocalRealtimeController } from "../../web-ui/local-runtime/realtime-controller.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import type { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(status: "completed" | "failed", scheduled = true) {
  const sessionsDir = await mkdtemp(join(tmpdir(), "schedule-resume-"));
  directories.push(sessionsDir);
  const sessions = createFileSessionStore({ sessionsDir });
  const requestId = "request-1";
  const sessionId = "session-1";
  const trigger = {
    type: "event",
    name: "schedule.triggered",
    environment: "dev",
    requestId,
    sessionId,
    messageId: "trigger",
    text: "Saved scheduled work",
    schedule: {
      jobId: "job",
      runId: "run",
      title: "Summary",
      scheduledAt: "2026-09-07T06:00:00Z",
      triggerType: "schedule",
    },
  };
  await sessions.startRequestStream(sessionId, requestId);
  await sessions.appendRequestEvent(
    sessionId,
    requestId,
    scheduled
      ? trigger
      : {
          type: "token",
          requestId,
          text: "Partial answer",
        },
  );
  await sessions.appendRequestEvent(sessionId, requestId, {
    type: status,
    requestId,
    ...(status === "completed"
      ? { output: "Saved answer" }
      : { error: "Saved failure" }),
  });
  const persisted = createFileSessionStore({ sessionsDir });
  const get = vi.fn(() => ({ services: { sessions: persisted } }));
  const controller = new LocalRealtimeController(
    { defaultEnvironmentId: "dev" },
    { get } as unknown as RuntimeEnvironmentRegistry,
    {} as LocalRequestExecution,
    new RealtimeClientHub(),
  );
  const sent: Record<string, unknown>[] = [];
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  });
  controller.connect(socket as unknown as WebSocket);
  return {
    trigger,
    async resume(afterSeq = 0) {
      socket.emit(
        "message",
        JSON.stringify({
          type: "resume_request",
          requestId,
          afterSeq,
          environment: "dev",
          sessionId: "untrusted-caller-session",
        }),
      );
      await vi.waitFor(() => expect(sent).toHaveLength(afterSeq === 0 ? 3 : 1));
      expect(get).toHaveBeenCalledExactlyOnceWith("dev");
      return sent;
    },
  };
}

test.each([
  ["completed", 0],
  ["failed", 0],
  ["completed", 2],
  ["failed", 2],
] as const)(
  "persisted scheduled %s replay after sequence %i releases the foreground composer",
  async (status, afterSeq) => {
    const f = await fixture(status);
    const harness = createPlanLifecycleHarness();
    harness.state.activeRequestId = "";
    if (afterSeq > 0) harness.realtime.handle(f.trigger);
    for (const message of await f.resume(afterSeq))
      harness.realtime.handle(message);
    expect(harness.state.activeRequestId).toBe("");
    const assistant = harness.state.messages.find(
      (item) =>
        item.role === "assistant" && item.requestId === f.trigger.requestId,
    );
    expect(assistant).toMatchObject({
      streaming: false,
      text: status === "completed" ? "Saved answer" : "Saved failure",
    });
    expect(harness.drainQueuedComposerMessage).toHaveBeenCalledOnce();
  },
);

test.each(["completed", "failed"] as const)(
  "a resumed background schedule's %s refreshes the sidebar without settling foreground work",
  async (status) => {
    const f = await fixture(status);
    const harness = createPlanLifecycleHarness();
    harness.state.currentSessionId = "foreground-session";
    harness.state.activeRequestId = "foreground-request";
    const before = structuredClone(harness.state);
    for (const message of await f.resume()) harness.realtime.handle(message);
    expect(harness.loadSessions).toHaveBeenCalledOnce();
    expect(harness.state).toEqual(before);
    expect(harness.drainQueuedComposerMessage).not.toHaveBeenCalled();
    expect(harness.markCurrentSessionReadSoon).not.toHaveBeenCalled();
  },
);

test("resume derives identity from persisted ownership and keeps foreign terminal scopes rejected", async () => {
  const f = await fixture("completed");
  const [terminal] = await f.resume(2);
  expect(terminal).toMatchObject({
    requestId: f.trigger.requestId,
    sessionId: f.trigger.sessionId,
    environment: "dev",
  });
  const harness = createPlanLifecycleHarness();
  harness.state.activeRequestId = "";
  harness.realtime.handle(f.trigger);
  const before = structuredClone(harness.state);
  for (const changes of [
    { sessionId: "foreign" },
    { environment: "foreign" },
  ]) {
    harness.realtime.handle({ ...terminal, ...changes });
    expect(harness.state).toEqual(before);
    expect(harness.drainQueuedComposerMessage).not.toHaveBeenCalled();
  }
  harness.realtime.handle(terminal);
  expect(harness.state.activeRequestId).toBe("");
  expect(harness.drainQueuedComposerMessage).toHaveBeenCalledOnce();
});

test.each(["completed", "failed"] as const)(
  "ordinary persisted %s replay preserves its existing terminal behavior",
  async (status) => {
    const f = await fixture(status, false);
    const harness = createPlanLifecycleHarness();
    for (const message of await f.resume()) harness.realtime.handle(message);
    expect(harness.state.activeRequestId).toBe("");
    expect(harness.state.messages[1]).toMatchObject({
      streaming: false,
      text: status === "completed" ? "Saved answer" : "Saved failure",
    });
    expect(harness.drainQueuedComposerMessage).toHaveBeenCalledOnce();
  },
);
