import { describe, expect, it } from "vitest";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const trigger = {
  type: "event",
  name: "schedule.triggered",
  environment: "dev",
  sessionId: "background-session",
  requestId: "scheduled-request",
  messageId: "schedule-trigger",
  schedule: {
    jobId: "job",
    runId: "run",
    title: "Morning summary",
    scheduledAt: "2026-09-07T06:00:00Z",
    triggerType: "schedule",
  },
};

const completed = {
  type: "completed",
  environment: "dev",
  sessionId: "background-session",
  requestId: "scheduled-request",
  output: "Saved scheduled answer",
};

describe("background scheduled conversation updates", () => {
  it.each(["completed", "failed"])(
    "refreshes the canonical sidebar on %s without altering the foreground conversation",
    async (type) => {
      const harness = createPlanLifecycleHarness();
      const { state, realtime, client, loadSessions } = harness;
      const before = structuredClone(state);
      const background = {
        id: trigger.sessionId,
        lastMessage: "Saved scheduled answer",
        readState: { unreadCount: 1 },
      };
      client.listSessions.mockResolvedValue({ sessions: [background] });
      realtime.handle(trigger);
      expect(loadSessions).not.toHaveBeenCalled();
      realtime.handle({ ...completed, type });
      await Promise.resolve();

      expect(loadSessions).toHaveBeenCalledTimes(1);
      expect(client.listSessions).toHaveBeenCalledWith("dev");
      expect(state.sessions).toEqual([background]);
      expect({ ...state, sessions: before.sessions }).toEqual(before);
      expect(harness.renderMessages).not.toHaveBeenCalled();
      expect(harness.markCurrentSessionReadSoon).not.toHaveBeenCalled();
      expect(harness.drainQueuedComposerMessage).not.toHaveBeenCalled();
      expect(client.loadSession).not.toHaveBeenCalled();
      realtime.handle({ ...completed, type });
      expect(loadSessions).toHaveBeenCalledTimes(1);
    },
  );

  it("refreshes after leaving the conversation in which the schedule started", async () => {
    const { state, realtime, loadSessions } = createPlanLifecycleHarness();
    state.activeRequestId = "";
    realtime.handle({ ...trigger, sessionId: "session-1" });
    expect(state.activeRequestId).toBe(trigger.requestId);
    state.currentSessionId = "new-foreground";
    state.activeRequestId = "foreground-request";
    const before = structuredClone(state);
    realtime.handle({ ...completed, sessionId: "session-1" });
    await Promise.resolve();
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(state).toEqual(before);
  });

  it("preserves an ordinary foreground request when a different schedule belongs to the same conversation", () => {
    const { state, realtime, loadSessions, drainQueuedComposerMessage } =
      createPlanLifecycleHarness();
    const before = structuredClone(state);
    realtime.handle({ ...trigger, sessionId: "session-1" });
    realtime.handle({ ...completed, sessionId: "session-1" });
    expect(state).toEqual(before);
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(drainQueuedComposerMessage).not.toHaveBeenCalled();
  });

  it("rejects a foreign environment terminal even when request and session match the scheduled foreground", () => {
    const { state, realtime, loadSessions } = createPlanLifecycleHarness();
    state.activeRequestId = "";
    realtime.handle({ ...trigger, sessionId: "session-1" });
    const before = structuredClone(state);
    realtime.handle({
      ...completed,
      sessionId: "session-1",
      environment: "other",
    });
    expect(state).toEqual(before);
    expect(loadSessions).not.toHaveBeenCalled();
    realtime.handle({ ...completed, sessionId: "session-1" });
    expect(state.activeRequestId).toBe("");
    expect(loadSessions).toHaveBeenCalledTimes(1);
  });

  it("tracks a running schedule whose trigger is already hydrated in conversation history", () => {
    const { state, realtime, loadSessions } = createPlanLifecycleHarness();
    state.messages.push({
      id: trigger.messageId,
      role: "user",
      text: "Stored trigger",
      requestId: trigger.requestId,
      schedule: trigger.schedule,
    });
    realtime.handle({ ...trigger, sessionId: "session-1" });
    state.currentSessionId = "new-foreground";
    realtime.handle({ ...completed, sessionId: "session-1" });
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(state.messages).toHaveLength(3);
    expect(state.activeRequestId).toBe("request-1");
  });

  it.each([
    { environment: "other" },
    { sessionId: "wrong-session" },
    { requestId: "wrong-request" },
  ])(
    "ignores an unrelated terminal without losing the tracked run: %j",
    (changes) => {
      const { realtime, loadSessions } = createPlanLifecycleHarness();
      realtime.handle(trigger);
      realtime.handle({ ...completed, ...changes });
      expect(loadSessions).not.toHaveBeenCalled();
      realtime.handle(completed);
      expect(loadSessions).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ environment: "other" }, { schedule: {} }])(
    "does not adopt a foreign or malformed trigger: %j",
    (changes) => {
      const { state, realtime, loadSessions } = createPlanLifecycleHarness();
      const before = structuredClone(state);
      realtime.handle({ ...trigger, ...changes });
      realtime.handle(completed);
      expect(state).toEqual(before);
      expect(loadSessions).not.toHaveBeenCalled();
    },
  );

  it("does not refresh a new environment for the old environment's terminal", () => {
    let environmentId = "dev";
    const { realtime, loadSessions } = createPlanLifecycleHarness(
      {},
      [],
      () => environmentId,
    );
    realtime.handle(trigger);
    environmentId = "prod";
    realtime.handle(completed);
    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("cannot repopulate the new environment with a late sidebar response", async () => {
    let environmentId = "dev";
    const { state, realtime, client } = createPlanLifecycleHarness(
      {},
      [],
      () => environmentId,
    );
    let finish!: (value: { sessions: Record<string, unknown>[] }) => void;
    client.listSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    realtime.handle(trigger);
    realtime.handle(completed);
    expect(client.listSessions).toHaveBeenCalledTimes(1);
    environmentId = "prod";
    state.sessions = [{ id: "prod-session" }];
    finish({ sessions: [{ id: "old-environment-session" }] });
    await Promise.resolve();
    expect(state.sessions).toEqual([{ id: "prod-session" }]);
  });

  it("does not recreate a deleted conversation from a late terminal", async () => {
    const { state, realtime, client } = createPlanLifecycleHarness();
    realtime.handle(trigger);
    state.sessions = [];
    client.listSessions.mockResolvedValue({ sessions: [] });
    const before = structuredClone(state);
    realtime.handle(completed);
    await Promise.resolve();
    expect(client.listSessions).toHaveBeenCalledTimes(1);
    expect(state).toEqual(before);
    expect(client.loadSession).not.toHaveBeenCalled();
  });

  it("discards a pending sidebar read superseded by the reload after deletion", async () => {
    const { state, realtime, client, conversationSession } =
      createPlanLifecycleHarness();
    let finishOldRead!: (value: {
      sessions: Record<string, unknown>[];
    }) => void;
    client.listSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldRead = resolve;
        }),
    );
    realtime.handle(trigger);
    realtime.handle(completed);
    await conversationSession.loadSessions();
    finishOldRead({ sessions: [{ id: trigger.sessionId }] });
    await Promise.resolve();
    expect(state.sessions).toEqual([]);
  });

  it("discards a terminal explicitly marked as belonging to a deleted session", () => {
    const { state, realtime, loadSessions } = createPlanLifecycleHarness();
    const before = structuredClone(state);
    realtime.handle(trigger);
    realtime.handle({ ...completed, sessionDeleted: true });
    expect(loadSessions).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });
});
