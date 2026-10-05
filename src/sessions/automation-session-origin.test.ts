import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { SessionService } from "./session-service.js";
import {
  type AutomationSessionHandle,
  type AutomationSessionOrigin,
} from "./automation-session-origin.js";

const directories: string[] = [];
const origin: AutomationSessionOrigin = {
  kind: "automation_node_v1",
  automationId: "automation-1",
  runId: "run-1",
  nodeId: "agent-1",
  attemptId: "attempt-1",
};

async function createService(): Promise<SessionService> {
  const sessionsDir = await mkdtemp(join(tmpdir(), "automation-session-"));
  directories.push(sessionsDir);
  return new SessionService({ sessionsDir });
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("locked automation node sessions", () => {
  test("the exact trusted handle can write while ordinary reads and lists omit the transcript", async () => {
    const service = await createService();
    await service.appendMessage("ordinary", "user", "hello");
    const handle = await service.createAutomationSession("internal", origin);

    await service.runAsAutomationSession(handle, async () => {
      await service.startRequestStream("internal", "request-internal");
      await service.appendMessage("internal", "user", "private assignment");
      await service.appendRequestEvent("internal", "request-internal", {
        type: "completed",
        output: "private result",
      });
      expect((await service.getSessionById("internal"))?.automationOrigin).toEqual(
        origin,
      );
    });

    await expect(service.getSessionById("internal")).resolves.toBeNull();
    await expect(service.getSessionSnapshot("internal")).resolves.toBeNull();
    await expect(
      service.getRequestReplayById("request-internal"),
    ).resolves.toBeNull();
    expect((await service.getAllSessions()).map((session) => session.id)).toEqual([
      "ordinary",
    ]);
    expect((await service.listSessions()).sessions.map((session) => session.id)).toEqual([
      "ordinary",
    ]);
    expect((await service.getSessionById("ordinary"))?.messages[0]?.content).toBe(
      "hello",
    );
  });

  test("ordinary send, steering persistence and destructive mutations reject before changing a locked session", async () => {
    const service = await createService();
    const handle = await service.createAutomationSession("internal", origin);
    await service.runAsAutomationSession(handle, async () => {
      await service.startRequestStream("internal", "request-internal");
      await service.appendMessage("internal", "user", "original");
    });

    const forbidden = [
      () => service.assertInteractiveSession("internal"),
      () => service.getOrCreateSession("internal"),
      () => service.appendMessage("internal", "user", "injected"),
      () =>
        service.appendRequestEvent("internal", "request-internal", {
          type: "injected",
        }),
      () => service.startRequestStream("internal", "injected-request"),
      () => service.updateSessionTitle("internal", "renamed"),
      () => service.clearSessionMessages("internal"),
      () => service.deleteMessageWithStats("internal", "msg-1"),
      () => service.deleteSessionWithStats("internal"),
    ];
    for (const mutation of forbidden)
      await expect(mutation()).rejects.toThrow("automation_session_locked");

    await service.runAsAutomationSession(handle, async () => {
      const session = await service.getSessionById("internal");
      expect(session?.messages.map((message) => message.content)).toEqual([
        "original",
      ]);
      expect(session?.requests?.map((request) => request.requestId)).toEqual([
        "request-internal",
      ]);
      expect(session?.title).toBe("internal");
    });
  });

  test("a copied handle or another service cannot assume the trusted write scope", async () => {
    const service = await createService();
    const handle = await service.createAutomationSession("internal", origin);
    const copied = { ...handle } as AutomationSessionHandle;
    await expect(
      service.runAsAutomationSession(copied, async () => undefined),
    ).rejects.toThrow("automation_session_locked");
    const otherService = await createService();
    await expect(
      otherService.runAsAutomationSession(handle, async () => undefined),
    ).rejects.toThrow("automation_session_locked");
  });

  test("a different run attempt cannot claim an existing internal session", async () => {
    const service = await createService();
    await service.createAutomationSession("internal", origin);
    await expect(
      service.createAutomationSession("internal", {
        ...origin,
        attemptId: "attempt-2",
      }),
    ).rejects.toThrow("automation_session_locked");
  });

  test("an existing ordinary conversation cannot be converted into an automation node", async () => {
    const service = await createService();
    await service.appendMessage("ordinary", "user", "hello");
    await expect(
      service.createAutomationSession("ordinary", origin),
    ).rejects.toThrow("automation_session_origin_conflict");
    expect((await service.getSessionById("ordinary"))?.automationOrigin).toBeUndefined();
    await service.appendMessage("ordinary", "assistant", "hi");
    expect((await service.getSessionById("ordinary"))?.messageCount).toBe(2);
  });
});
