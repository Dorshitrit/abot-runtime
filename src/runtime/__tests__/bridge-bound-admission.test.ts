import type WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionStore } from "../ports.js";

vi.mock("../request/handler.js", () => ({ handleRunRequest: vi.fn() }));
const { handleRunRequest } = await import("../request/handler.js");
const { createBoundBridgeRequestHandler } = await import("../../bridge/bound-request-handler.js");
const execute = vi.mocked(handleRunRequest);
afterEach(() => execute.mockReset());
const socket = {} as WebSocket;
const message = (requestId: string, sessionId: string) => ({ type: "run_request" as const, requestId, sessionId, text: "Work" });

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("standalone Bridge rejects overlapping canonical sessions and keeps other sessions concurrent", async () => {
  const complete = gate();
  execute.mockImplementation(async () => complete.promise);
  const handler = createBoundBridgeRequestHandler({});
  const accepted = vi.fn();
  const first = handler.handle(socket, message("first", " session "), { onAccepted: accepted });
  await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  try {
    await expect(handler.handle(socket, message("second", "session"))).rejects.toThrow("session_busy");
    expect(execute).toHaveBeenCalledOnce();
    const otherAccepted = vi.fn();
    const other = handler.handle(socket, message("other", "different"), { onAccepted: otherAccepted });
    await vi.waitFor(() => expect(otherAccepted).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledTimes(2);
    complete.resolve();
    await Promise.all([first, other]);
    await handler.handle(socket, message("later", "session"));
    expect(execute).toHaveBeenCalledTimes(3);
  } finally { complete.resolve(); await first; }
});

test("standalone Bridge checks saved approvals before acknowledgement or execution", async () => {
  const listWaiting = vi.fn(async () => [{}]);
  const handler = createBoundBridgeRequestHandler({
    sessionStore: { requestLifecycle: { listWaiting } } as unknown as SessionStore,
  });
  const accepted = vi.fn();
  await expect(handler.handle(socket, message("new", " session "), { onAccepted: accepted }))
    .rejects.toThrow("session_awaiting_approval");
  expect(listWaiting).toHaveBeenCalledWith("session");
  expect(accepted).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
