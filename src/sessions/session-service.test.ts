import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { buildContextBuckets, buildContextWindow } from "./context-window.js";
import { SessionService } from "./session-service.js";

const tempDirs: string[] = [];

async function createTempSessionsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llm-runtime-sessions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("SessionService", () => {
  test("creates and loads session by provided id", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({
      sessionsDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const created = await service.getOrCreateSession("sess-1");
    expect(created.id).toBe("sess-1");
    expect(created.title).toBe("sess-1");
    expect(created.messageCount).toBe(0);
    expect(created.messages).toEqual([]);

    const loaded = await service.getSessionById("sess-1");
    expect(loaded).toEqual(created);
  });

  test("delete and reset session behavior", async () => {
    const sessionsDir = await createTempSessionsDir();
    let tick = 0;
    const service = new SessionService({
      sessionsDir,
      now: () => new Date(`2026-01-01T00:00:0${tick++}.000Z`),
      createMessageId: () => `msg-${tick}`,
    });

    await service.appendMessage("sess-2", "user", "hello");
    await service.appendMessage("sess-2", "assistant", "hi");

    const reset = await service.resetSession("sess-2");
    expect(reset?.messageCount).toBe(0);
    expect(reset?.messages).toEqual([]);
    expect(reset?.id).toBe("sess-2");

    const deleted = await service.deleteSession("sess-2");
    expect(deleted).toBe(true);
    const missing = await service.getSessionById("sess-2");
    expect(missing).toBeNull();
  });

  test("append and delete message updates counts and disk", async () => {
    const sessionsDir = await createTempSessionsDir();
    let idx = 0;
    const service = new SessionService({
      sessionsDir,
      now: () =>
        new Date(`2026-01-01T00:00:${String(idx).padStart(2, "0")}.000Z`),
      createMessageId: () => `m-${++idx}`,
    });

    await service.appendMessage("sess-3", "user", "q1", {
      lastAgentMode: "deep",
    });
    const afterSecond = await service.appendMessage(
      "sess-3",
      "assistant",
      "a1",
      {
        lastAgentMode: "deep",
      },
    );

    expect(afterSecond.lastAgentMode).toBe("deep");
    expect(afterSecond.messageCount).toBe(2);
    expect(afterSecond.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);

    const updated = await service.deleteMessage("sess-3", "m-1");
    expect(updated?.messageCount).toBe(1);
    expect(updated?.messages.map((m) => m.id)).toEqual(["m-2"]);

    const fromDiskRaw = await readFile(
      join(sessionsDir, "sess-3.json"),
      "utf-8",
    );
    const fromDisk = JSON.parse(fromDiskRaw) as {
      messageCount: number;
      messages: Array<{ id: string }>;
    };
    expect(fromDisk.messageCount).toBe(1);
    expect(fromDisk.messages.map((m) => m.id)).toEqual(["m-2"]);
  });

  test("persists message attachment metadata", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({ sessionsDir });

    const session = await service.appendMessage(
      "sess-attachments",
      "user",
      "q",
      {
        attachments: [
          {
            id: "att-1",
            kind: "image",
            mimeType: "image/png",
            storageRef: "sess-attachments/req-1/att-1.png",
            name: "screen.png",
            size: 4,
          },
        ],
      },
    );

    const snapshot = await service.getSessionSnapshot("sess-attachments");

    expect(session.messages[0]?.attachments).toEqual([
      {
        id: "att-1",
        kind: "image",
        mimeType: "image/png",
        storageRef: "sess-attachments/req-1/att-1.png",
        name: "screen.png",
        size: 4,
      },
    ]);
    expect(snapshot?.messages[0]?.attachments).toEqual(
      session.messages[0]?.attachments,
    );
  });

  test("updates session title and exposes it in list and snapshot results", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({
      sessionsDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await service.appendMessage("sess-title", "user", "Summarize a roadmap");
    const updated = await service.updateSessionTitle(
      "sess-title",
      "Roadmap Summary",
    );
    const list = await service.listSessions();
    const snapshot = await service.getSessionSnapshot("sess-title");

    expect(updated?.title).toBe("Roadmap Summary");
    expect(list.sessions[0]?.title).toBe("Roadmap Summary");
    expect(snapshot?.title).toBe("Roadmap Summary");
  });

  test("getAllSessions returns persisted sessions", async () => {
    const sessionsDir = await createTempSessionsDir();
    let offset = 0;
    const service = new SessionService({
      sessionsDir,
      now: () =>
        new Date(`2026-01-01T00:00:${String(offset++).padStart(2, "0")}.000Z`),
      createMessageId: () => `id-${offset}`,
    });

    await service.appendMessage("s-a", "user", "A");
    await service.appendMessage("s-b", "user", "B");
    const sessions = await service.getAllSessions();
    expect(sessions.map((s) => s.id).sort()).toEqual(["s-a", "s-b"]);
  });

  test("default message ids are sequential and deterministic", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({
      sessionsDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await service.appendMessage("sess-4", "user", "one");
    await service.appendMessage("sess-4", "assistant", "two");
    const session = await service.getSessionById("sess-4");
    expect(session?.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
  });

  test("rejects invalid session ids", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({ sessionsDir });
    await expect(service.getOrCreateSession("../bad")).rejects.toThrow(
      "invalid sessionId",
    );
  });

  test("persists optional grounding metadata on assistant messages", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({
      sessionsDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await service.appendMessage("sess-5", "assistant", "Observed earlier.", {
      grounding: "conversation",
      observationMeta: {
        kind: "stable_fact",
        carryPolicy: "always",
      },
      observationContent: "Structured fact: user favorite color is blue.",
    });

    const session = await service.getSessionById("sess-5");
    expect(session?.messages[0]).toMatchObject({
      role: "assistant",
      content: "Observed earlier.",
      grounding: "conversation",
      observationMeta: {
        kind: "stable_fact",
        carryPolicy: "always",
      },
      observationContent: "Structured fact: user favorite color is blue.",
    });
  });

  test("persists optional task type on messages and clears it on reset", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({
      sessionsDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createMessageId: (session) => `m-${session.messages.length + 1}`,
    });

    await service.appendMessage("sess-task-type", "user", "Build a page", {
      taskType: "development",
    });

    const session = await service.getSessionById("sess-task-type");
    expect(session?.messages[0]).toMatchObject({
      role: "user",
      content: "Build a page",
      taskType: "development",
    });

    await service.resetSession("sess-task-type");

    const reset = await service.getSessionById("sess-task-type");
    expect(reset?.messages).toEqual([]);
  });

  test("persists session runtime mode and clears it with session messages", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({
      sessionsDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await service.appendMessage("sess-runtime-mode", "user", "Build a page");
    await service.updateSessionRuntimeMode("sess-runtime-mode", "development");

    const session = await service.getSessionById("sess-runtime-mode");
    expect(session?.runtimeModeId).toBe("development");

    await service.clearSessionMessages("sess-runtime-mode");

    const cleared = await service.getSessionById("sess-runtime-mode");
    expect(cleared?.messages).toEqual([]);
    expect(cleared?.runtimeModeId).toBeUndefined();
  });

  test("persists optional thinking trace on assistant messages", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({
      sessionsDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await service.appendMessage("sess-thinking", "assistant", "Done.", {
      thinkingTrace: [
        {
          sequence: 1,
          step: "decision.initial",
          status: "completed",
          text: "I should inspect the current state first.",
        },
        {
          sequence: 2,
          step: "final.initial",
          status: "completed",
          text: "Now I can summarize the result.",
        },
      ],
    });

    const session = await service.getSessionById("sess-thinking");
    expect(session?.messages[0]).toMatchObject({
      role: "assistant",
      content: "Done.",
      thinkingTrace: [
        {
          sequence: 1,
          step: "decision.initial",
          status: "completed",
          text: "I should inspect the current state first.",
        },
        {
          sequence: 2,
          step: "final.initial",
          status: "completed",
          text: "Now I can summarize the result.",
        },
      ],
    });
  });

  test("persists request event streams with replayable payloads", async () => {
    const sessionsDir = await createTempSessionsDir();
    let tick = 0;
    const service = new SessionService({
      sessionsDir,
      now: () =>
        new Date(`2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`),
    });

    await service.startRequestStream("sess-events", "req-1");
    await service.appendRequestEvent("sess-events", "req-1", {
      type: "event",
      requestId: "req-1",
      name: "planner.plan.created",
      plan: {
        total: 1,
        completed: 0,
        items: [{ id: "task-1", title: "Inspect UI contract", status: "open" }],
      },
    });
    await service.appendRequestEvent("sess-events", "req-1", {
      type: "completed",
      requestId: "req-1",
      output: "Done.",
    });

    const session = await service.getSessionById("sess-events");
    expect(session?.requests).toHaveLength(1);
    expect(session?.requests?.[0]).toMatchObject({
      requestId: "req-1",
      sessionId: "sess-events",
      status: "completed",
      lastSeqNo: 2,
    });
    expect(session?.requests?.[0]?.events.map((event) => event.seqNo)).toEqual([
      1, 2,
    ]);
    expect(session?.requests?.[0]?.events[0]?.payload).toMatchObject({
      type: "event",
      requestId: "req-1",
      seqNo: 1,
      name: "planner.plan.created",
      plan: {
        total: 1,
        completed: 0,
      },
    });
    expect(session?.requests?.[0]?.events[1]?.payload).toMatchObject({
      type: "completed",
      requestId: "req-1",
      seqNo: 2,
      output: "Done.",
    });
  });

  test("loads request event replay by request id with final state", async () => {
    const sessionsDir = await createTempSessionsDir();
    let tick = 0;
    const service = new SessionService({
      sessionsDir,
      now: () =>
        new Date(`2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`),
    });

    await service.startRequestStream("sess-events", "req-lookup");
    await service.appendRequestEvent("sess-events", "req-lookup", {
      type: "event",
      requestId: "req-lookup",
      name: "planner.plan.created",
    });
    await service.appendRequestEvent("sess-events", "req-lookup", {
      type: "token",
      requestId: "req-lookup",
      text: "partial",
    });
    await service.appendRequestEvent("sess-events", "req-lookup", {
      type: "completed",
      requestId: "req-lookup",
      output: "Done.",
    });

    const replay = await service.getRequestReplayById("req-lookup", 1);

    expect(replay).toMatchObject({
      requestId: "req-lookup",
      sessionId: "sess-events",
      finalState: {
        status: "completed",
        output: "Done.",
        completedAt: Date.parse("2026-01-01T00:00:04.000Z"),
      },
    });
    expect(replay?.events).toEqual([
      {
        type: "token",
        requestId: "req-lookup",
        seqNo: 2,
        timestamp: Date.parse("2026-01-01T00:00:03.000Z"),
        text: "partial",
      },
      {
        type: "completed",
        requestId: "req-lookup",
        seqNo: 3,
        timestamp: Date.parse("2026-01-01T00:00:04.000Z"),
        output: "Done.",
      },
    ]);
  });

  test("lists session summaries and returns snapshots with message filtering", async () => {
    const sessionsDir = await createTempSessionsDir();
    let tick = 0;
    const service = new SessionService({
      sessionsDir,
      now: () =>
        new Date(`2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`),
    });

    await service.appendMessage("sess-list-a", "user", "First question");
    await service.appendMessage("sess-list-a", "assistant", "First answer");
    await service.startRequestStream("sess-list-a", "req-list-a");
    await service.appendRequestEvent("sess-list-a", "req-list-a", {
      type: "completed",
      requestId: "req-list-a",
      output: "First answer",
    });
    await service.appendMessage("sess-list-b", "user", "Latest question");
    await service.appendMessage(
      "sess-list-b",
      "assistant",
      "Development continuity snapshot:\nModel work state:\nWork items:\n- [open] internal only",
      {
        grounding: "tool_observation",
        observationMeta: {
          kind: "task_result",
          carryPolicy: "always",
          taskResultRole: "authoritative_project_handoff",
        },
        observationContent:
          "Development continuity snapshot:\nModel work state:\nWork items:\n- [open] internal only",
      },
    );

    const list = await service.listSessions({ limit: 1 });
    expect(list.sessions).toEqual([
      expect.objectContaining({
        id: "sess-list-b",
        latestMessageId: 1,
        latestAssistantMessageId: null,
        lastMessagePreview: "Latest question",
      }),
    ]);
    expect(list.nextCursor).toBe("1");

    const snapshot = await service.getSessionSnapshot("sess-list-a", {
      afterMessageId: 1,
      includeRequests: true,
    });
    expect(snapshot?.messages).toEqual([
      expect.objectContaining({
        id: 2,
        sessionId: "sess-list-a",
        role: "assistant",
        text: "First answer",
        source: "request",
        requestId: "req-list-a",
      }),
    ]);
    expect(snapshot?.requests).toEqual([
      expect.objectContaining({
        requestId: "req-list-a",
        status: "completed",
        finalState: expect.objectContaining({
          status: "completed",
          output: "First answer",
        }),
      }),
    ]);

    const snapshotWithInternalObservation = await service.getSessionSnapshot(
      "sess-list-b",
      {
        afterMessageId: 0,
        includeRequests: true,
      },
    );
    expect(snapshotWithInternalObservation?.messages).toEqual([
      expect.objectContaining({
        id: 1,
        sessionId: "sess-list-b",
        role: "user",
        text: "Latest question",
      }),
    ]);
  });

  test("stores context entries separately from client-visible messages", async () => {
    const sessionsDir = await createTempSessionsDir();
    let tick = 0;
    const service = new SessionService({
      sessionsDir,
      now: () =>
        new Date(`2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`),
    });

    await service.appendMessage("sess-context", "user", "Build the app");
    await service.appendContextEntry("sess-context", {
      kind: "tool_observation",
      content:
        "Development continuity snapshot:\nSummary: checkpoint before finalization",
      observationMeta: {
        kind: "task_result",
        carryPolicy: "always",
        taskResultRole: "authoritative_project_handoff",
      },
      requestId: "req-context",
    });

    const stored = await service.getSessionById("sess-context");
    expect(stored?.messages).toHaveLength(1);
    expect(stored?.contextEntries).toEqual([
      expect.objectContaining({
        id: "ctx-1",
        kind: "tool_observation",
        requestId: "req-context",
        content: expect.stringContaining("Development continuity snapshot:"),
      }),
    ]);

    const snapshot = await service.getSessionSnapshot("sess-context");
    expect(snapshot?.messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Build the app",
      }),
    ]);

    const clear = await service.clearSessionMessages("sess-context");
    expect(clear?.cleared).toBe(true);
    const cleared = await service.getSessionById("sess-context");
    expect(cleared?.messages).toEqual([]);
    expect(cleared?.contextEntries).toEqual([]);
  });

  test("keeps only the latest task result context entry per handoff role", async () => {
    const sessionsDir = await createTempSessionsDir();
    let tick = 0;
    const service = new SessionService({
      sessionsDir,
      now: () =>
        new Date(`2026-01-01T00:01:${String(tick++).padStart(2, "0")}.000Z`),
    });

    await service.appendContextEntry("sess-context-prune", {
      kind: "tool_observation",
      content: "Development continuity snapshot:\nSummary: old handoff",
      observationMeta: {
        kind: "task_result",
        carryPolicy: "always",
        taskResultRole: "authoritative_project_handoff",
      },
      requestId: "req-old",
    });
    await service.appendContextEntry("sess-context-prune", {
      kind: "tool_observation",
      content: "Development continuity snapshot:\nSummary: latest handoff",
      observationMeta: {
        kind: "task_result",
        carryPolicy: "always",
        taskResultRole: "authoritative_project_handoff",
      },
      requestId: "req-new",
    });
    await service.appendContextEntry("sess-context-prune", {
      kind: "tool_observation",
      content: "Regular carried fact",
      observationMeta: {
        kind: "stable_fact",
        carryPolicy: "always",
      },
      requestId: "req-fact",
    });

    const stored = await service.getSessionById("sess-context-prune");
    expect(stored?.contextEntries).toEqual([
      expect.objectContaining({
        requestId: "req-new",
        content: expect.stringContaining("latest handoff"),
      }),
      expect.objectContaining({
        requestId: "req-fact",
        content: "Regular carried fact",
      }),
    ]);
  });

  test("deletes and clears session-owned messages and requests with stats", async () => {
    const sessionsDir = await createTempSessionsDir();
    const service = new SessionService({ sessionsDir });

    await service.appendMessage("sess-delete", "user", "Question");
    await service.appendMessage("sess-delete", "assistant", "Answer", {
      requestId: "req-delete",
      source: "request",
    });
    await service.startRequestStream("sess-delete", "req-delete");
    await service.appendRequestEvent("sess-delete", "req-delete", {
      type: "completed",
      requestId: "req-delete",
      output: "Answer",
    });
    await service.appendContextEntry("sess-delete", {
      kind: "tool_observation",
      content: "Hidden development handoff",
      observationMeta: {
        kind: "task_result",
        carryPolicy: "always",
      },
      requestId: "req-delete",
    });

    const messageDelete = await service.deleteMessageWithStats(
      "sess-delete",
      "2",
    );
    expect(messageDelete).toMatchObject({
      sessionId: "sess-delete",
      messageId: "2",
      deleted: true,
      deletedRequestId: "req-delete",
      deletedRequestEvents: 1,
    });
    expect(
      (await service.getSessionById("sess-delete"))?.requests ?? [],
    ).toEqual([]);
    expect(
      (await service.getSessionById("sess-delete"))?.contextEntries ?? [],
    ).toEqual([]);

    await service.startRequestStream("sess-delete", "req-clear");
    await service.appendMessage("sess-delete", "assistant", "Another answer");
    const clear = await service.clearSessionMessages("sess-delete");
    expect(clear).toMatchObject({
      sessionId: "sess-delete",
      cleared: true,
      deletedMessages: 2,
      deletedRequests: 1,
    });

    await service.appendMessage("sess-delete", "user", "Recreated");
    const deleted = await service.deleteSessionWithStats("sess-delete");
    expect(deleted).toMatchObject({
      sessionId: "sess-delete",
      deleted: true,
      deletedMessages: 1,
      deletedRequests: 0,
    });
    expect(await service.getSessionById("sess-delete")).toBeNull();
  });

  test("compacts high-volume request stream snapshots", async () => {
    const sessionsDir = await createTempSessionsDir();
    let tick = 0;
    const service = new SessionService({
      sessionsDir,
      now: () =>
        new Date(`2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`),
    });

    await service.startRequestStream("sess-stream-compact", "req-compact");
    await service.appendRequestEvent("sess-stream-compact", "req-compact", {
      type: "event",
      requestId: "req-compact",
      name: "thinking.delta",
      delta: "a",
      text: "a",
    });
    await service.appendRequestEvent("sess-stream-compact", "req-compact", {
      type: "event",
      requestId: "req-compact",
      name: "thinking.delta",
      delta: "aa",
      text: "aa",
    });
    await service.appendRequestEvent("sess-stream-compact", "req-compact", {
      type: "token",
      requestId: "req-compact",
      text: "before tool",
    });
    await service.appendRequestEvent("sess-stream-compact", "req-compact", {
      type: "event",
      requestId: "req-compact",
      name: "tool.started",
      tool: "read_file",
    });
    await service.appendRequestEvent("sess-stream-compact", "req-compact", {
      type: "event",
      requestId: "req-compact",
      name: "thinking.delta",
      delta: "b",
      text: "ab",
    });
    await service.appendRequestEvent("sess-stream-compact", "req-compact", {
      type: "event",
      requestId: "req-compact",
      name: "token",
      text: "raw chunk",
    });
    await service.appendRequestEvent("sess-stream-compact", "req-compact", {
      type: "token",
      requestId: "req-compact",
      text: "partial",
    });
    await service.appendRequestEvent("sess-stream-compact", "req-compact", {
      type: "token",
      requestId: "req-compact",
      text: "final answer",
    });

    const session = await service.getSessionById("sess-stream-compact");
    const request = session?.requests?.[0];

    expect(request?.lastSeqNo).toBe(8);
    expect(
      request?.events.map((event) => ({
        seqNo: event.seqNo,
        type: event.type,
        name: event.payload.name,
        text: event.payload.text,
      })),
    ).toEqual([
      {
        seqNo: 2,
        type: "event",
        name: "thinking.delta",
        text: "aa",
      },
      {
        seqNo: 3,
        type: "token",
        name: undefined,
        text: "before tool",
      },
      {
        seqNo: 4,
        type: "event",
        name: "tool.started",
        text: undefined,
      },
      {
        seqNo: 5,
        type: "event",
        name: "thinking.delta",
        text: "ab",
      },
      {
        seqNo: 8,
        type: "token",
        name: undefined,
        text: "final answer",
      },
    ]);
  });

  test("serializes session message and request event mutations", async () => {
    const sessionsDir = await createTempSessionsDir();
    let tick = 0;
    const service = new SessionService({
      sessionsDir,
      now: () =>
        new Date(`2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`),
    });

    await Promise.all([
      service.appendMessage("sess-concurrent", "user", "hello"),
      service.startRequestStream("sess-concurrent", "req-concurrent"),
      service.appendRequestEvent("sess-concurrent", "req-concurrent", {
        type: "event",
        requestId: "req-concurrent",
        name: "runtime.state",
        stage: "context_build",
      }),
      service.appendMessage("sess-concurrent", "assistant", "hi"),
      service.appendRequestEvent("sess-concurrent", "req-concurrent", {
        type: "completed",
        requestId: "req-concurrent",
        output: "hi",
      }),
    ]);

    const session = await service.getSessionById("sess-concurrent");
    expect(session?.messages.map((message) => message.content).sort()).toEqual([
      "hello",
      "hi",
    ]);
    expect(session?.requests).toHaveLength(1);
    expect(session?.requests?.[0]?.events).toHaveLength(2);
    expect(session?.requests?.[0]?.status).toBe("completed");
  });
});

describe("buildContextWindow", () => {
  test("keeps chronological order and returns last N messages", () => {
    const messages = Array.from({ length: 12 }).map((_, i) => ({
      id: `m-${i + 1}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `c-${i + 1}`,
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    }));
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:11.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 12,
      messages,
    };

    const context = buildContextWindow(session, 10);
    expect(context).toHaveLength(10);
    expect(context[0]).toEqual({ role: "user", content: "c-3" });
    expect(context[9]).toEqual({ role: "assistant", content: "c-12" });
  });

  test("excludes tool observations from the plain conversation window", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 3,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "What did you find earlier?",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "The prior lookup said 72F.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "tool_observation" as const,
        },
        {
          id: "m-3",
          role: "assistant" as const,
          content: "I can help with that.",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    };

    const context = buildContextWindow(session, 10);
    expect(context).toEqual([
      { role: "user", content: "What did you find earlier?" },
      { role: "assistant", content: "I can help with that." },
    ]);
  });
});

describe("buildContextBuckets", () => {
  test("carries only tool observations explicitly marked always", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 5,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Tell me what you know.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "I remember that your favorite color is blue.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "stable_fact" as const,
            carryPolicy: "always" as const,
          },
          observationContent: "My favorite color is blue.",
        },
        {
          id: "m-3",
          role: "assistant" as const,
          content: "The latest war update came from the web.",
          createdAt: "2026-01-01T00:00:02.000Z",
          grounding: "tool_observation" as const,
          observationMeta: {
            kind: "volatile_external" as const,
            carryPolicy: "never" as const,
          },
        },
        {
          id: "m-4",
          role: "assistant" as const,
          content: "Legacy observation without meta.",
          createdAt: "2026-01-01T00:00:03.000Z",
          grounding: "tool_observation" as const,
        },
        {
          id: "m-5",
          role: "assistant" as const,
          content: "I can help with that.",
          createdAt: "2026-01-01T00:00:04.000Z",
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      maxConversationMessages: 4,
      maxToolObservationMessages: 4,
    });

    expect(buckets.priorToolObservations).toEqual([
      {
        role: "system",
        contextMessageKind: "prior_tool_observation",
        content:
          "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.\nMy favorite color is blue.",
      },
    ]);
    expect(buckets.recentConversation).toEqual([
      { role: "user", content: "Tell me what you know." },
      { role: "assistant", content: "I can help with that." },
    ]);
  });

  test("can disable recent conversation carry while preserving carryable observations", () => {
    const session = {
      id: "s",
      title: "s",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      lastAgentMode: "reasoning" as const,
      messageCount: 2,
      messages: [
        {
          id: "m-1",
          role: "user" as const,
          content: "Search the web for AI news.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-2",
          role: "assistant" as const,
          content: "I remember that your name is Test User.",
          createdAt: "2026-01-01T00:00:01.000Z",
          grounding: "conversation" as const,
          observationMeta: {
            kind: "stable_fact" as const,
            carryPolicy: "always" as const,
          },
          observationContent: "My name is Test User.",
        },
      ],
    };

    const buckets = buildContextBuckets(session, {
      includeRecentConversation: false,
      maxConversationMessages: 4,
      maxToolObservationMessages: 4,
    });

    expect(buckets.recentConversation).toEqual([]);
    expect(buckets.priorToolObservations).toEqual([
      {
        role: "system",
        contextMessageKind: "prior_tool_observation",
        content:
          "Context note: This message was derived from a previous tool-based observation and may not reflect current external state.\nMy name is Test User.",
      },
    ]);
  });
});
