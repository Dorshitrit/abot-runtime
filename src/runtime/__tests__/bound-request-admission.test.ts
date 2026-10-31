import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { RuntimeEnvironmentServices } from "../composition.js";
import { createBoundRuntimeRequestHandler } from "../request/bound-runtime-handler.js";
import { SessionRequestAdmission } from "../request/session-admission.js";
import { handleRunRequest } from "../request/handler.js";

vi.mock("../request/handler.js", () => ({ handleRunRequest: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function gate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => { open = resolve; });
  return { waiting, open };
}

function handlerFixture() {
  const beginInteractive = vi.fn(() => vi.fn());
  const handler = createBoundRuntimeRequestHandler({
    requestAdmission: new SessionRequestAdmission(() => false),
    passiveLearning: { beginInteractive },
  } as unknown as RuntimeEnvironmentServices);
  const socket = {} as WebSocket;
  const message = { type: "run_request", requestId: "first", sessionId: "session", text: "hello" };
  return { handler, socket, message, beginInteractive };
}

test("canonical admission precedes acceptance and protects trimmed session identity", async () => {
  const f = handlerFixture();
  const acceptance = gate();
  const execution = gate();
  vi.mocked(handleRunRequest).mockImplementation(() => execution.waiting);
  const onAccepted = vi.fn(() => acceptance.waiting);
  const first = f.handler.handle(f.socket, f.message, { onAccepted });
  expect(onAccepted).toHaveBeenCalledOnce();
  const rejectedAcceptance = vi.fn();
  await expect(f.handler.handle(f.socket, {
    ...f.message, requestId: "second", sessionId: " session ",
  }, { onAccepted: rejectedAcceptance })).rejects.toThrow("session_busy");
  expect(rejectedAcceptance).not.toHaveBeenCalled();
  expect(handleRunRequest).not.toHaveBeenCalled();
  expect(f.beginInteractive).not.toHaveBeenCalled();
  acceptance.open();
  await vi.waitFor(() => expect(handleRunRequest).toHaveBeenCalledOnce());
  await expect(f.handler.handle(f.socket, { ...f.message, requestId: "third" })).rejects.toThrow("session_busy");
  expect(handleRunRequest).toHaveBeenCalledOnce();
  execution.open();
  await first;
  await f.handler.handle(f.socket, { ...f.message, requestId: "fourth" });
  expect(handleRunRequest).toHaveBeenCalledTimes(2);
});

test("failed acceptance releases the session without starting request work", async () => {
  const f = handlerFixture();
  const failure = new Error("peer disconnected");
  await expect(f.handler.handle(f.socket, f.message, {
    onAccepted: () => Promise.reject(failure),
  })).rejects.toBe(failure);
  expect(handleRunRequest).not.toHaveBeenCalled();
  expect(f.beginInteractive).not.toHaveBeenCalled();
  vi.mocked(handleRunRequest).mockResolvedValue(undefined);
  await f.handler.handle(f.socket, { ...f.message, requestId: "retry" });
  expect(handleRunRequest).toHaveBeenCalledOnce();
});
