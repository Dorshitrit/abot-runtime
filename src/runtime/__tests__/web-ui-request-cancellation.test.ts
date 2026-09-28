import { createServer } from "node:http";
import type WebSocket from "ws";
import { expect, test, vi } from "vitest";
import { cancelWebRequest } from "../../web-ui/local-runtime/request-cancellation-route.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import { LocalRuntimeClientRequests } from "../local-host/client-requests.js";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import type { LocalRuntimePeer } from "../local-host/contracts.js";

test("stop HTTP route reaches the owner and enforces origin and session identity", async () => {
  const controls = new LocalRequestControls(() => {});
  const peer: LocalRuntimePeer = {
    id: "test",
    callClient: async () => null,
    onClose: () => () => {},
  };
  const options = controls.ordinary("request", peer, {}, "session");
  const client = new LocalRuntimeClientRequests(async (method, args) => {
    expect(method).toBe("request.cancel");
    return controls.cancel(args[0], args[1]);
  });
  const environment = { requests: client.requests } as RuntimeEnvironment;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    await cancelWebRequest({
      request,
      response,
      environment,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const url = `http://127.0.0.1:${address.port}`;
  const stop = (sessionId: string, origin = url) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify({ requestId: "request", sessionId }),
    });
  try {
    expect((await stop("session", "https://cross-site.invalid")).status).toBe(
      403,
    );
    expect(await (await stop("wrong-session")).json()).toMatchObject({
      accepted: false,
      reason: "session_mismatch",
    });
    expect(options.abortSignal?.aborted).toBe(false);
    expect(await (await stop("session")).json()).toMatchObject({
      accepted: true,
    });
    expect(options.abortSignal?.reason.message).toBe("request_cancelled");
    expect(await (await stop("session")).json()).toMatchObject({
      accepted: true,
    });
    controls.finish("request");
    expect(await (await stop("session")).json()).toMatchObject({
      accepted: false,
      reason: "request_not_active",
    });
  } finally {
    controls.stop();
    client.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test("a stop submitted before owner acceptance waits for registration and preserves request identity", async () => {
  let finish!: () => void;
  const run = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const call = vi.fn(async (method: string) =>
    method === "request.run" ? run : { accepted: true },
  );
  const client = new LocalRuntimeClientRequests(call);
  const pending = client.requests.handle(
    { send: vi.fn() } as unknown as WebSocket,
    {
      type: "run_request",
      requestId: "request",
      sessionId: "session",
      text: "Work",
    },
  );
  const stopping = client.requests.cancel!("request", "session");
  expect(call).toHaveBeenCalledTimes(1);
  await client.handleCallback("request.accepted", ["request"]);
  await expect(stopping).resolves.toEqual({ accepted: true });
  expect(call).toHaveBeenLastCalledWith("request.cancel", [
    "request",
    "session",
  ]);
  finish();
  await pending;
  client.close();
});
