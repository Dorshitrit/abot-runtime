import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SocketConnectionRoutes } from "./socket-connection-routes.js";

function fixture(allowPublishedLoopback = false) {
  const status = { revision: 2, localEnvironmentId: "prod", remoteRuntimeId: "Laptop", serverOrigin: "wss://socket.example",
    source: "managed" as const, state: "paused" as const, lastRegisteredAt: null, nextRetryAt: null, error: null };
  const preview = { localEnvironmentId: "prod", remoteRuntimeId: "Laptop", serverOrigin: "wss://socket.example", bindingConfirmationRequired: true };
  const client = { status: vi.fn(async () => status), preview: vi.fn(async (_bundle: unknown) => preview),
    import: vi.fn(async (_input: unknown) => status), pause: vi.fn(async (_input: unknown) => status),
    resume: vi.fn(async (_input: unknown) => status), forget: vi.fn(async (_input: unknown) => status) };
  const resolve = vi.fn(() => client);
  const routes = new SocketConnectionRoutes(resolve, () => "prod", allowPublishedLoopback);
  async function call(method = "GET", route = "socket-connection", body?: unknown, options: {
    headers?: Record<string, string>; remote?: string; local?: string; raw?: string; query?: string;
  } = {}) {
    const chunks = options.raw !== undefined ? [Buffer.from(options.raw)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const request = Object.assign(Readable.from(chunks), {
      method, url: "/web-api/" + route + (options.query ?? ""),
      headers: { host: "localhost:8080", "content-type": "application/json", ...options.headers },
      rawHeaders: ["Host", "localhost:8080"],
      socket: { remoteAddress: options.remote ?? "127.0.0.1", localAddress: options.local ?? "127.0.0.1", localPort: 8080 },
    }) as unknown as IncomingMessage;
    let code = 0; let json: any;
    const headers: Record<string, unknown> = {};
    const response = { setHeader: (key: string, value: unknown) => { headers[key] = value; },
      writeHead: (value: number) => { code = value; }, end: (raw: string) => { json = JSON.parse(raw); } } as unknown as ServerResponse;
    const handled = await routes.handle(route, request, response);
    return { handled, code, json, headers };
  }
  return { call, resolve, client, status, preview };
}

describe("local Socket connection HTTP adapter", () => {
  it("reads Runtime's public status for the selected environment without a mutation", async () => {
    const f = fixture();
    const result = await f.call("GET", "socket-connection", undefined, { query: "?environment=dev" });
    expect(result).toMatchObject({ handled: true, code: 200, headers: { "cache-control": "no-store" }, json: { ok: true, connection: f.status } });
    expect(f.resolve).toHaveBeenCalledWith("dev");
    expect(f.client.status).toHaveBeenCalledOnce();
    expect(f.client.import).not.toHaveBeenCalled();
  });

  it("previews an imported object without persisting it and passes explicit binding consent to Runtime", async () => {
    const f = fixture();
    const bundle = { runtimeId: "Laptop", agentBridgeUrl: "wss://socket.example/agent-bridge", runtimeToken: "private-fixture" };
    const preview = await f.call("POST", "socket-connection/preview", { bundle });
    expect(preview.json).toEqual({ ok: true, preview: f.preview });
    expect(f.client.preview).toHaveBeenCalledWith(bundle);
    expect(f.client.import).not.toHaveBeenCalled();
    expect(JSON.stringify(preview.json)).not.toContain(bundle.runtimeToken);
    const connected = await f.call("POST", "socket-connection/connect", { bundle, expectedRevision: 2, confirmBinding: true, secretExtra: "ignore" });
    expect(connected.code).toBe(200);
    expect(f.client.import).toHaveBeenCalledExactlyOnceWith({ bundle, expectedRevision: 2, confirmBinding: true });
  });

  it.each(["pause", "resume", "forget"] as const)("delegates %s with the observed revision", async action => {
    const f = fixture();
    expect((await f.call("POST", "socket-connection/" + action, { expectedRevision: 2 })).code).toBe(200);
    expect(f.client[action]).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 2 });
    const missing = await f.call("POST", "socket-connection/" + action, {});
    expect(missing).toMatchObject({ code: 400, json: { error: "socket_connection_revision_required" } });
    expect(f.client[action]).toHaveBeenCalledTimes(1);
  });

  it.each([
    { remote: "192.0.2.15" },
    { local: "192.0.2.16" },
    { headers: { origin: "https://outside.example" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { host: "outside.example:8080" } },
    { remote: "192.0.2.15", headers: { "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost:8080" } },
  ] as Array<{ remote?: string; local?: string; headers?: Record<string, string> }>)("blocks remote reads and writes before accessing the owner %#", async options => {
    const f = fixture();
    for (const [method, route] of [["GET", "socket-connection"], ["POST", "socket-connection/forget"]]) {
      expect((await f.call(method, route, { expectedRevision: 2 }, options)).code).toBe(403);
    }
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("honors explicit listener-owned Docker trust but still rejects cross-origin writes", async () => {
    const f = fixture(true);
    expect((await f.call("GET", "socket-connection", undefined, { remote: "172.17.0.1", local: "172.17.0.2" })).code).toBe(200);
    const rejected = await f.call("POST", "socket-connection/pause", { expectedRevision: 2 },
      { remote: "172.17.0.1", local: "172.17.0.2", headers: { origin: "https://outside.example" } });
    expect(rejected.code).toBe(403);
    expect(f.client.pause).not.toHaveBeenCalled();
  });

  it("bounds import bodies, requires JSON and never exposes parser or service errors", async () => {
    const f = fixture();
    expect((await f.call("POST", "socket-connection/connect", {}, { headers: { "content-type": "text/plain" } })).code).toBe(415);
    expect((await f.call("POST", "socket-connection/preview", undefined, { raw: "x".repeat(16_385) })).code).toBe(413);
    const invalid = await f.call("POST", "socket-connection/preview", undefined, { raw: '{"SECRET invalid' });
    expect(JSON.stringify(invalid.json)).not.toContain("SECRET");
    expect(f.resolve).not.toHaveBeenCalled();
    f.client.status.mockRejectedValueOnce(new Error("SECRET /private/path"));
    const failed = await f.call();
    expect(failed.json.error).toBe("socket_connection_failed");
    expect(JSON.stringify(failed.json)).not.toContain("SECRET");
  });

  it("returns a revision conflict without retrying the user's command", async () => {
    const f = fixture();
    f.client.pause.mockRejectedValueOnce(new Error("socket_connection_revision_conflict"));
    const result = await f.call("POST", "socket-connection/pause", { expectedRevision: 1 });
    expect(result).toMatchObject({ code: 409, json: { error: "socket_connection_revision_conflict" } });
    expect(f.client.pause).toHaveBeenCalledTimes(1);
  });
});
