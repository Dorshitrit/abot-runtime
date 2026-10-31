import { createServer, request, type IncomingMessage } from "node:http";
import { expect, onTestFinished, test, vi } from "vitest";
import { ChatGptPublishedCallbacks } from "./published-callback.js";

function publishedRequest(host: string, rawHeaders = ["Host", host]): IncomingMessage {
  return {
    headers: { host },
    rawHeaders,
    socket: { localAddress: "172.17.0.2", remoteAddress: "172.17.0.1", localPort: 5177 },
  } as IncomingMessage;
}

async function fixture(encrypted = false) {
  const registry = new ChatGptPublishedCallbacks();
  const server = createServer(async (incoming, response) => {
    Object.defineProperty(incoming.socket, "encrypted", { value: encrypted });
    const pathname = (incoming.url ?? "").split("?", 1)[0];
    if (await registry.handle(incoming, response, pathname)) return;
    response.writeHead(404);
    response.end("Not found.");
  });
  onTestFinished(async () => {
    registry.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_listener");
  const host = "127.0.0.1:" + address.port;
  const factory = registry.factory(publishedRequest("localhost:" + address.port));
  const send = (
    path: string,
    options: { method?: string; headers?: Record<string, string> | string[] } = {},
  ) => new Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1", port: address.port, path, method: options.method ?? "GET",
      agent: false, headers: options.headers ?? { host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers,
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
  return { registry, factory, send, host, port: address.port };
}

const callbackPath = (state = "first") => "/auth/callback?state=" + state + "&code=CALLBACK_SECRET";

test("receives a cross-site authorization return on the published HTTP port", async () => {
  const f = await fixture();
  const consume = vi.fn(async (_parameters: URLSearchParams) => {});
  const callback = await f.factory(consume, { state: "first" });
  expect(callback.redirectUri).toBe("http://" + f.host + "/auth/callback");
  const response = await f.send(callbackPath(), { headers: {
    host: f.host, origin: "https://auth.openai.com", "sec-fetch-site": "cross-site",
  } });
  expect(response.status).toBe(200);
  expect(consume).toHaveBeenCalledOnce();
  expect(consume.mock.calls[0][0].get("code")).toBe("CALLBACK_SECRET");
  expect(response.body).not.toContain("CALLBACK_SECRET");
  expect(response.headers).toMatchObject({
    "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  });
});

test.each([
  "foreign-host", "wrong-port", "localhost-alias", "duplicate-host", "post",
  "duplicate-state", "duplicate-code", "fragment", "oversized", "unknown-state",
])("rejects %s without consuming the legitimate callback", async (kind) => {
  const f = await fixture();
  const consume = vi.fn(async () => {});
  await f.factory(consume, { state: "first" });
  const hosts: Record<string, string> = {
    "foreign-host": "evil.example:" + f.port,
    "wrong-port": "127.0.0.1:" + (f.port + 1),
    "localhost-alias": "localhost:" + f.port,
  };
  const paths: Record<string, string> = {
    "duplicate-state": callbackPath() + "&state=second",
    "duplicate-code": callbackPath() + "&code=SECOND_SECRET",
    fragment: callbackPath() + "#CALLBACK_SECRET",
    oversized: callbackPath() + "&extra=" + "x".repeat(8192),
    "unknown-state": callbackPath("unknown"),
  };
  const response = await f.send(paths[kind] ?? callbackPath(), {
    method: kind === "post" ? "POST" : "GET",
    headers: kind === "duplicate-host"
      ? ["Host", f.host, "Host", "evil.example"]
      : { host: hosts[kind] ?? f.host },
  });
  expect(response.status).toBe(400);
  expect(response.body).not.toContain("CALLBACK_SECRET");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(consume).not.toHaveBeenCalled();
  expect((await f.send(callbackPath())).status).toBe(200);
  expect(consume).toHaveBeenCalledOnce();
});

test("binds concurrent attempts independently and rejects replay", async () => {
  const f = await fixture();
  const first = vi.fn(async () => {});
  const second = vi.fn(async () => {});
  await f.factory(first, { state: "first" });
  await f.factory(second, { state: "second" });
  expect((await f.send(callbackPath("second"))).status).toBe(200);
  expect(second).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
  expect((await f.send(callbackPath("second"))).status).toBe(400);
  expect((await f.send(callbackPath())).status).toBe(200);
  expect(first).toHaveBeenCalledOnce();
});

test("fences replay before the first callback consumer settles", async () => {
  const f = await fixture();
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const consume = vi.fn(async () => { started(); await pending; });
  await f.factory(consume, { state: "first" });
  const first = f.send(callbackPath());
  try {
    await entered;
    expect((await f.send(callbackPath())).status).toBe(400);
    expect(consume).toHaveBeenCalledOnce();
  } finally { release(); }
  expect((await first).status).toBe(200);
});

test("removes cancelled callbacks and fences factories when the listener closes", async () => {
  const f = await fixture();
  const consume = vi.fn(async () => {});
  const callback = await f.factory(consume, { state: "first" });
  callback.close();
  callback.close();
  expect((await f.send(callbackPath())).status).toBe(400);
  await f.factory(consume, { state: "second" });
  f.registry.close();
  expect((await f.send(callbackPath("second"))).status).toBe(400);
  await expect(f.factory(consume, { state: "third" })).rejects.toThrow();
  expect(() => f.registry.factory(publishedRequest(f.host))).toThrow();
  expect(consume).not.toHaveBeenCalled();
});

test("preserves an existing registration on a duplicate factory state", async () => {
  const f = await fixture();
  const first = vi.fn(async () => {});
  const second = vi.fn(async () => {});
  await f.factory(first, { state: "first" });
  await expect(f.factory(second, { state: "first" })).rejects.toThrow();
  expect((await f.send(callbackPath())).status).toBe(200);
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
});

test("returns constant failure text and consumes a failing authorization once", async () => {
  const f = await fixture();
  const consume = vi.fn(async () => { throw new Error("CALLBACK_SECRET"); });
  await f.factory(consume, { state: "first" });
  const response = await f.send(callbackPath());
  expect(response.status).toBe(400);
  expect(response.body).not.toContain("CALLBACK_SECRET");
  expect((await f.send(callbackPath())).status).toBe(400);
  expect(consume).toHaveBeenCalledOnce();
});

test("leaves other paths to their owner and rejects untrusted factory authorities", async () => {
  const f = await fixture();
  expect((await f.send("/other-path")).status).toBe(404);
  expect(() => f.registry.factory(publishedRequest("evil.example:5196"))).toThrow();
  expect(() => f.registry.factory(publishedRequest("localhost:5196/path"))).toThrow();
  expect(() => f.registry.factory(publishedRequest(f.host, ["Host", f.host, "Host", f.host]))).toThrow();
});

test("accepts only the HTTP transport bound into the redirect URI", async () => {
  const f = await fixture(true);
  const consume = vi.fn(async () => {});
  await f.factory(consume, { state: "first" });
  expect((await f.send(callbackPath())).status).toBe(400);
  expect(consume).not.toHaveBeenCalled();
  const encrypted = publishedRequest(f.host);
  Object.defineProperty(encrypted.socket, "encrypted", { value: true });
  expect(() => f.registry.factory(encrypted)).toThrow();
});
