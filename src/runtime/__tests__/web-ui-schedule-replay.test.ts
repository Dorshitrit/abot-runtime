import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import { LocalRuntimeClientRequests } from "../local-host/client-requests.js";
import type { LocalRuntimePeer } from "../local-host/contracts.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const run: SchedulerRun = {
  id: "run",
  jobId: "job",
  requestId: "scheduled-request",
  environmentId: "dev",
  sessionId: "background-session",
  title: "Morning summary",
  prompt: "Private saved activation prompt",
  modelProfileId: "model",
  agentMode: "reasoning",
  timeZone: "UTC",
  jobRevision: 1,
  scheduledAt: "2026-09-07T06:00:00Z",
  trigger: "schedule",
  status: "running",
};
const terminal = {
  type: "completed",
  requestId: run.requestId,
  sessionId: run.sessionId,
  environment: run.environmentId,
  output: "Saved answer",
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function attachWebToActiveSchedule() {
  const browser = createPlanLifecycleHarness();
  const initialEvents: unknown[] = [];
  const controls = new LocalRequestControls((event) =>
    initialEvents.push(event),
  );
  controls.scheduled(run);
  const hub = new RealtimeClientHub();
  const requests = new LocalRequestExecution(hub);
  const client = new LocalRuntimeClientRequests(vi.fn(), (active) =>
    requests.scheduledRequestOptions(active),
  );
  client.subscribe((event) => requests.publishScheduled(event));
  const peer: LocalRuntimePeer = {
    id: "new-web-peer",
    callClient: vi.fn((method, args) => client.handleCallback(method, args)),
    onClose: () => () => {},
  };
  await controls.register(peer);
  const sent: Record<string, unknown>[] = [];
  hub.add({
    OPEN: 1,
    readyState: 1,
    on: vi.fn(),
    send(data: string) {
      const event = JSON.parse(data) as Record<string, unknown>;
      sent.push(event);
      browser.realtime.handle(event);
    },
  } as unknown as WebSocket);
  cleanups.push(() => {
    controls.finish(run.requestId);
    client.close();
  });
  return { browser, sent, client, requests, peer, initialEvents };
}

describe("scheduled completion after Web attaches during a run", () => {
  it.each(["completed", "failed"])(
    "refreshes the background sidebar on %s without requiring a replayed trigger",
    async (type) => {
      const { browser, sent, client, peer, requests } =
        await attachWebToActiveSchedule();
      expect(peer.callClient).toHaveBeenCalledExactlyOnceWith(
        "scheduled.started",
        [run],
      );
      expect(requests.healthDetails()).toMatchObject([
        { requestId: run.requestId },
      ]);
      expect(sent).toEqual([]);
      const before = structuredClone(browser.state);
      const updated = {
        id: run.sessionId,
        readState: { unreadCount: 1 },
        lastMessage: "Saved answer",
      };
      browser.client.listSessions.mockResolvedValue({ sessions: [updated] });
      client.receive({ type: "scheduled.event", event: { ...terminal, type } });
      await Promise.resolve();

      expect(browser.loadSessions).toHaveBeenCalledTimes(1);
      expect(browser.client.listSessions).toHaveBeenCalledWith("dev");
      expect(browser.state.sessions).toEqual([updated]);
      expect({ ...browser.state, sessions: before.sessions }).toEqual(before);
      expect(browser.renderMessages).not.toHaveBeenCalled();
      expect(browser.markCurrentSessionReadSoon).not.toHaveBeenCalled();
      expect(browser.drainQueuedComposerMessage).not.toHaveBeenCalled();
      expect(browser.client.loadSession).not.toHaveBeenCalled();
      expect(sent).toEqual([{ ...terminal, type, requestOrigin: "schedule" }]);
      expect(JSON.stringify(sent)).not.toContain(run.prompt);
      expect(requests.healthDetails()).toEqual([]);
    },
  );

  it("does not add terminal provenance to intermediate scheduled events", async () => {
    const { sent, client, browser } = await attachWebToActiveSchedule();
    const event = {
      type: "event",
      name: "thinking.delta",
      requestId: run.requestId,
      sessionId: run.sessionId,
      environment: "dev",
      text: "Working",
    };
    client.receive({ type: "scheduled.event", event });
    expect(sent).toEqual([event]);
    expect(browser.loadSessions).not.toHaveBeenCalled();
  });

  it("keeps ordinary background terminals outside scheduled refresh handling", async () => {
    const { browser } = await attachWebToActiveSchedule();
    browser.realtime.handle(terminal);
    expect(browser.loadSessions).not.toHaveBeenCalled();
  });

  it("suppresses a deleted session terminal before publishing to the browser", async () => {
    const { browser, client, sent, requests } =
      await attachWebToActiveSchedule();
    const before = structuredClone(browser.state);
    client.receive({
      type: "scheduled.event",
      event: { ...terminal, sessionDeleted: true },
    });
    expect(sent).toEqual([]);
    expect(browser.state).toEqual(before);
    expect(browser.loadSessions).not.toHaveBeenCalled();
    expect(requests.healthDetails()).toEqual([]);
  });

  it.each([
    { environment: "other" },
    { environment: "" },
    { sessionId: "" },
    { requestId: "" },
    { sessionId: "", requestId: "" },
    { sessionDeleted: true },
  ])(
    "rejects untracked terminal provenance without a current complete scope: %j",
    async (changes) => {
      const { browser } = await attachWebToActiveSchedule();
      const before = structuredClone(browser.state);
      browser.realtime.handle({
        ...terminal,
        requestOrigin: "schedule",
        ...changes,
      });
      expect(browser.state).toEqual(before);
      expect(browser.loadSessions).not.toHaveBeenCalled();
    },
  );

  it("preserves normal settlement of the matching foreground request", async () => {
    const { browser, client } = await attachWebToActiveSchedule();
    client.receive({
      type: "scheduled.event",
      event: { ...terminal, requestId: "request-1", sessionId: "session-1" },
    });
    expect(browser.state.activeRequestId).toBe("");
    expect(browser.state.messages[1].text).toBe("Saved answer");
    expect(browser.loadSessions).toHaveBeenCalledTimes(1);
    expect(browser.drainQueuedComposerMessage).toHaveBeenCalledTimes(1);
  });
});
