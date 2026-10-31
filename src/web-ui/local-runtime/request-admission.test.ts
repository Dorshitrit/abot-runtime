import { createServer, type Server } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { SessionRequestAdmission } from "../../runtime/request/session-admission.js";
import type { RuntimeRequestHandler } from "../../runtime/composition.js";
import type { RuntimeEnvironment } from "./contracts.js";
import { LocalRequestExecution } from "./request-execution.js";
import { RealtimeClientHub } from "./realtime-hub.js";

const servers: Server[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}

async function fixture(handle: RuntimeRequestHandler["handle"]) {
  const events: Record<string, unknown>[] = [];
  const execution = new LocalRequestExecution(new RealtimeClientHub((event) => events.push(event)));
  const environment = { services: { sessions: {} }, requests: { handle } } as unknown as RuntimeEnvironment;
  const server = createServer((request, response) => {
    const sessionId = request.url!.slice(1);
    void execution.start(response, { text: "New instruction", sessionId }, "prod", environment)
      .catch(() => { response.writeHead(500); response.end(); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  return { execution, events, post: (sessionId: string) => fetch(`http://127.0.0.1:${address.port}/${sessionId}`, { method: "POST" }) };
}

test("the HTTP acknowledgement waits for owner admission, not request completion", async () => {
  const admitted = gate(); const complete = gate(); const entered = gate();
  const f = await fixture(async (_ws, _message, options) => {
    entered.resolve();
    await admitted.promise;
    await options?.onAccepted?.();
    await complete.promise;
  });
  const responded = vi.fn();
  const response = f.post("session").then((result) => { responded(); return result; });
  await entered.promise;
  expect(responded).not.toHaveBeenCalled();
  admitted.resolve();
  expect((await response).status).toBe(200);
  expect(f.execution.healthDetails()).toHaveLength(1);
});

test("busy admission returns a definite HTTP refusal and separate sessions continue", async () => {
  const admission = new SessionRequestAdmission(() => false);
  const complete = gate();
  const started: string[] = [];
  const f = await fixture(async (_ws, message, options) => {
    await admission.run(String(message.sessionId), async () => {
      await options?.onAccepted?.();
      started.push(String(message.sessionId));
      await complete.promise;
    });
  });
  const first = await f.post("same");
  expect(first.status).toBe(200);
  const rejected = await f.post("same");
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({ ok: false, error: "session_busy", message: expect.any(String) });
  expect(started).toEqual(["same"]);
  expect(f.events).toEqual([]);
  await vi.waitFor(() => expect(f.execution.healthDetails()).toHaveLength(1));
  expect((await f.post("different")).status).toBe(200);
  expect(started).toEqual(["same", "different"]);
  complete.resolve();
  await vi.waitFor(() => expect(f.execution.healthDetails()).toEqual([]));
  expect((await f.post("same")).status).toBe(200);
  expect(started).toEqual(["same", "different", "same"]);
});

test("ordinary execution failures retain the existing accepted request and terminal event contract", async () => {
  const f = await fixture(async (_ws, _message, options) => {
    await options?.onAccepted?.();
    throw new Error("execution_failed");
  });
  const response = await f.post("session");
  expect(response.status).toBe(200);
  const { requestId } = await response.json();
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({
    type: "failed", requestId, sessionId: "session", error: "execution_failed",
  })));
});

test("a restored approval wait returns a definite refusal without a transient failed run", async () => {
  const admission = new SessionRequestAdmission(() => false, async () => true);
  const execute = vi.fn(async () => {});
  const f = await fixture(async (_ws, message, options) => {
    await admission.run(String(message.sessionId), async () => {
      await options?.onAccepted?.();
      await execute();
    });
  });
  const response = await f.post("waiting");
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ ok: false, error: "session_awaiting_approval" });
  expect(execute).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});
