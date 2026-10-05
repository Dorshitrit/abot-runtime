import { randomUUID } from "node:crypto";
import { createServer, request as requestHttp } from "node:http";
import { expect, test, vi } from "vitest";
import { HostPermissionRoute } from "../../web-ui/system-host-setup/permission-route.js";
import { NativeRuntimePermissionRoute } from "../../web-ui/system-host-setup/native-permission-route.js";
import { sendJson } from "../../web-ui/local-runtime/http.js";
import type { NativePermissionClient, NativePermissionStatus } from "../../computer-access/native-permission-contract.js";

async function fixture(platform: NodeJS.Platform = "darwin") {
  const ownerId = randomUUID();
  const metadata = { available: true as const, ownerId, computerName: "Runtime Mac", executablePath: "/native/node" };
  const status = vi.fn(async (): Promise<NativePermissionStatus> => metadata);
  const prepare = vi.fn(async () => ({ ownerId, executablePath: "/native/node", restartMayBeRequired: false,
    permissions: { screenRecording: "required", accessibility: "required" } as const }));
  let client: NativePermissionClient | undefined = { status, prepare };
  const access = vi.fn((environmentId: string) => environmentId === "dev" ? client : undefined);
  const native = new NativeRuntimePermissionRoute(access, platform);
  const companion = { status: () => ({ paired: false, connected: false } as const), execute: vi.fn() };
  const route = new HostPermissionRoute(companion, native);
  let closeResponse!: () => void;
  const closed = new Promise<void>((resolve) => { closeResponse = resolve; });
  const server = createServer((request, response) => {
    response.once("close", closeResponse);
    if (request.method === "GET") {
      void native.status(request).then((snapshot) => sendJson(response, 200, snapshot));
      return;
    }
    void route.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const input = { scope: "native_runtime", environmentId: "dev", ownerId, action: "check" };
  return { base, input, metadata, status, prepare, companion, access, closed,
    setClient(value: NativePermissionClient | undefined) { client = value; },
    post(value: unknown = input, options: RequestInit = {}) {
      return fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value), ...options });
    },
    postHost(host: string) {
      return new Promise<number>((resolve, reject) => {
        const request = requestHttp(base, { method: "POST", headers: { "content-type": "application/json", host } }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        });
        request.once("error", reject);
        request.end(JSON.stringify(input));
      });
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test("native metadata is environment scoped and preparation uses its exact owner, independently of companion", async () => {
  const f = await fixture();
  try {
    expect(await (await fetch(f.base + "?environment=dev")).json()).toEqual({ scope: "native_runtime", environmentId: "dev", ...f.metadata });
    expect(f.prepare).not.toHaveBeenCalled();
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, scope: "native_runtime", environmentId: "dev", ownerId: f.input.ownerId,
      permissions: { screenRecording: "required", accessibility: "required" } });
    expect(f.prepare).toHaveBeenCalledWith({ ownerId: f.input.ownerId, action: "check" });
    expect(f.companion.execute).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("unknown environments and stale owners do not create a Runtime or dispatch permissions", async () => {
  const f = await fixture();
  try {
    expect(await (await fetch(f.base + "?environment=missing")).json()).toMatchObject({ available: false, reason: "runtime_not_started" });
    expect((await f.post({ ...f.input, environmentId: "missing" })).status).toBe(409);
    expect((await f.post({ ...f.input, ownerId: randomUUID() })).status).toBe(409);
    f.status.mockImplementationOnce(async () => { f.setClient(undefined); return f.metadata; });
    expect((await f.post()).status).toBe(409);
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test.each(["linux", "win32"] as const)("%s cannot prepare native Mac permissions even with a Mac browser or companion", async (platform) => {
  const f = await fixture(platform);
  try {
    expect(await (await fetch(f.base + "?environment=dev")).json()).toMatchObject({ available: false, reason: "native_macos_unavailable" });
    expect((await f.post()).status).toBe(409);
    expect(f.access).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("native control enforces same origin, loopback authority, strict actions and bounded JSON", async () => {
  const f = await fixture();
  try {
    expect((await f.post(undefined, { headers: { "content-type": "application/json", origin: "https://untrusted.example" } })).status).toBe(403);
    expect(await f.postHost("external.example")).toBe(409);
    expect((await f.post({ ...f.input, command: "extra" })).status).toBe(400);
    expect((await f.post({ ...f.input, permission: "accessibility" })).status).toBe(400);
    expect((await f.post({ ...f.input, environmentId: "x".repeat(1100) })).status).toBe(400);
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("closing the browser during metadata resolution suppresses a not-yet-dispatched permission request", async () => {
  const f = await fixture();
  let finish!: (value: NativePermissionStatus) => void;
  f.status.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  try {
    const stop = new AbortController();
    const pending = f.post({ ...f.input, action: "request", permission: "accessibility" }, { signal: stop.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.status).toHaveBeenCalledOnce());
    stop.abort();
    await rejected;
    await f.closed;
    finish(f.metadata);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.prepare).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test("an environment replaced during permission execution does not receive a ready receipt", async () => {
  const f = await fixture();
  try {
    f.prepare.mockImplementationOnce(async () => {
      f.setClient(undefined);
      return { ownerId: f.input.ownerId, executablePath: "/native/node", restartMayBeRequired: false,
        permissions: { screenRecording: "required", accessibility: "required" } };
    });
    const response = await f.post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "macos_permissions_owner_changed" });
  } finally { await f.close(); }
});
