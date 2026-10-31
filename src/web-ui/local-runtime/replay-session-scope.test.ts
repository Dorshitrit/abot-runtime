import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { LocalRuntimeApiRouter } from "./api-router.js";
import { LocalRealtimeController } from "./realtime-controller.js";
import { LocalRequestExecution } from "./request-execution.js";
import { RealtimeClientHub } from "./realtime-hub.js";
import type { RuntimeEnvironmentRegistry } from "./environment-registry.js";
import type { ResolvedLocalRuntimeBackendOptions } from "./contracts.js";
import { traceDebug } from "../../runtime/observability/debug-logger.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function fixture() {
  const replay = { requestId: "request", sessionId: "authoritative-session", events: [], finalState: null };
  const getRequestReplayById = vi.fn(async (_id: string, _after?: number, _session?: string) => replay);
  const list = vi.fn(async (_session?: string) => []);
  const environments = { get: () => ({ services: { sessions: { getRequestReplayById } }, approvals: { list } }) } as unknown as RuntimeEnvironmentRegistry;
  const clients = new RealtimeClientHub();
  const requests = new LocalRequestExecution(clients);
  const options = { defaultEnvironmentId: "dev" } as ResolvedLocalRuntimeBackendOptions;
  const sent: Record<string, unknown>[] = [];
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1, readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  });
  const realtime = new LocalRealtimeController(options, environments, requests, clients);
  realtime.connect(socket as unknown as WebSocket);
  return { replay, getRequestReplayById, list, sent,
    router: new LocalRuntimeApiRouter(options, environments, requests),
    resume: (sessionId?: string) => socket.emit("message", JSON.stringify({
      type: "resume_request", requestId: "request", afterSeq: 4, environment: "dev", sessionId,
    })),
  };
}

function completedResumes() {
  return vi.mocked(traceDebug).mock.calls.filter(([, event]) => event === "resume.dispatch_returned");
}

test("HTTP replay forwards the optional session hint without changing the response", async () => {
  const f = fixture();
  let payload: Record<string, unknown> = {};
  const writeHead = vi.fn();
  const response = { writeHead, end: (raw: string) => { payload = JSON.parse(raw); } } as unknown as ServerResponse;
  await f.router.handle({ method: "GET", url: "/web-api/requests/request/events?afterSeq=4&environment=dev&sessionId=known-session", headers: {} } as IncomingMessage, response);
  expect(f.getRequestReplayById).toHaveBeenCalledExactlyOnceWith("request", 4, "known-session");
  expect(writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(payload).toEqual({ ok: true, requestId: "request", events: [], finalState: null });
});

test.each([undefined, "authoritative-session", "unrelated-session"])(
  "resume scopes approval reads to the found request even with hint %s", async (hint) => {
    const f = fixture();
    f.resume(hint);
    await vi.waitFor(() => expect(completedResumes()).toHaveLength(1));
    expect(f.getRequestReplayById.mock.calls).toEqual([
      ["request", 4, hint],
      ["request", 4, "authoritative-session"],
    ]);
    expect(f.list).toHaveBeenCalledExactlyOnceWith("authoritative-session");
    expect(f.sent).toEqual([]);
  },
);

test("overlapping resumes retain their request scope and independent replies", async () => {
  const f = fixture();
  f.resume("authoritative-session");
  f.resume("authoritative-session");
  await vi.waitFor(() => expect(completedResumes()).toHaveLength(2));
  expect(f.getRequestReplayById.mock.calls).toHaveLength(4);
  expect(f.getRequestReplayById.mock.calls.every((args) => args[2] === "authoritative-session")).toBe(true);
  expect(f.list.mock.calls).toEqual([["authoritative-session"], ["authoritative-session"]]);
  expect(f.sent).toEqual([]);
});
