import { afterEach, expect, test, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ManagedLlamaService } from "./service.js";
import { ManagedLlamaRoutes } from "./routes.js";
import { ManagedLlamaError, type LaunchSettings } from "./contracts.js";
import type { InstalledLlama } from "./install.js";
import type { LifecyclePhase } from "./lifecycle.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, realpath: vi.fn(original.realpath), lstat: vi.fn(original.lstat) };
});

const platform = { os: "darwin", arch: "arm64" };
const settings: LaunchSettings = { modelPath: "/synthetic/never-read.gguf", port: 18443, alias: "unit", contextTokens: 1024, gpuLayers: 0 };
const secret = "synthetic-private-token";
const connection = { baseUrl: "http://127.0.0.1:18443", model: "unit", contextWindowTokens: 1024, apiKey: secret };
const receipt = { executable: "/synthetic/never-executed/llama-server" } as InstalledLlama;
const roots: string[] = [];
const services: ManagedLlamaService[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(installed = true) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "abot-llama-service-unit-"));
  roots.push(root);
  let phase: LifecyclePhase = "idle";
  let ownsProcess = false;
  const inspect = vi.fn(async (): Promise<InstalledLlama | null> => installed ? receipt : null);
  const install = vi.fn(async (_signal?: AbortSignal) => { installed = true; return receipt; });
  const lifecycle = {
    status: vi.fn(() => ({ phase, closed: false, ownsProcess })),
    start: vi.fn(async (_input: unknown) => { phase = "ready"; ownsProcess = true; return connection; }),
    stop: vi.fn(async () => { phase = "stopped"; ownsProcess = false; }),
    close: vi.fn(async () => { phase = "stopped"; ownsProcess = false; }),
    readyConnection: vi.fn(() => phase === "ready" ? connection : null),
  };
  const createInstaller = vi.fn(() => ({ inspect, install }));
  const createLifecycle = vi.fn(() => lifecycle);
  const download = vi.fn(async () => { throw new Error("unexpected download"); });
  const spawn = vi.fn(() => { throw new Error("unexpected spawn"); });
  const health = vi.fn(async () => { throw new Error("unexpected network"); });
  const service = new ManagedLlamaService(root, { platform, createInstaller, createLifecycle, download, spawn, health });
  services.push(service);
  return { root, service, inspect, install, lifecycle, createInstaller, createLifecycle, download, spawn, health };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("construction/status/capabilities do no filesystem, installer, network or process work", async () => {
  const f = await fixture();
  const realpath = vi.mocked(fs.realpath).mockClear();
  const lstat = vi.mocked(fs.lstat).mockClear();
  const service = new ManagedLlamaService(join(f.root, "absent"), {
    platform, createInstaller: f.createInstaller, createLifecycle: f.createLifecycle,
    download: f.download, spawn: f.spawn, health: f.health,
  });
  services.push(service);
  expect(service.status()).toMatchObject({ phase: "idle", installation: "unknown", ownsProcess: false });
  expect(service.capabilities()).toMatchObject({ supported: true, modelDownload: false });
  expect(realpath).not.toHaveBeenCalled(); expect(lstat).not.toHaveBeenCalled();
  realpath.mockClear(); lstat.mockClear();
  for (const spy of [f.createInstaller, f.createLifecycle, f.inspect, f.install, f.download, f.spawn, f.health]) expect(spy).not.toHaveBeenCalled();
  expect(await fs.readdir(f.root)).toEqual([]);
});

test("install is explicit, serializes with all actions and never starts a process", async () => {
  const f = await fixture(false);
  const entered = deferred<void>(); const release = deferred<InstalledLlama>();
  f.install.mockImplementation(async () => { entered.resolve(); return release.promise; });
  const work = f.service.install();
  try {
    await entered.promise;
    expect(f.service.status().phase).toBe("installing");
    for (const other of [f.service.install(), f.service.start(settings), f.service.refreshStatus()])
      await expect(other).rejects.toMatchObject({ code: "busy" });
    expect(f.lifecycle.start).not.toHaveBeenCalled();
    expect(f.install).toHaveBeenCalledOnce();
  } finally { release.resolve(receipt); await work; }
  expect(f.service.status().installation).toBe("installed");
});

test("start is serialized and action/status omit credentials while explicit configuration access retains them", async () => {
  const f = await fixture();
  const entered = deferred<void>(); const release = deferred<typeof connection>();
  const original = f.lifecycle.start.getMockImplementation()!;
  f.lifecycle.start.mockImplementation(async input => { entered.resolve(); await release.promise; return original(input); });
  const work = f.service.start(settings);
  let result;
  try {
    await entered.promise;
    await expect(f.service.start(settings)).rejects.toMatchObject({ code: "busy" });
    await expect(f.service.install()).rejects.toMatchObject({ code: "busy" });
    expect(f.service.readyConnectionForConfiguration()).toBeNull();
  } finally { release.resolve(connection); result = await work; }
  expect(f.lifecycle.start).toHaveBeenCalledExactlyOnceWith(settings);
  expect(f.createLifecycle).toHaveBeenCalledOnce();
  expect(f.install).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(f.service.status())).not.toContain("apiKey");
  expect(f.service.readyConnectionForConfiguration()).toEqual(connection);
  await f.service.stop();
  expect(f.service.readyConnectionForConfiguration()).toBeNull();
});

test.each(["stop", "cancel", "close"] as const)("%s cancels pending install and fences concurrent work", async action => {
  const f = await fixture(false);
  const entered = deferred<AbortSignal>();
  f.install.mockImplementation(signal => new Promise((_yes, no) => {
    entered.resolve(signal!);
    signal!.addEventListener("abort", () => no(signal!.reason), { once: true });
  }));
  const work = f.service.install().catch(error => error);
  const signal = await entered.promise;
  const stopped = f.service[action]();
  expect(signal.aborted).toBe(true);
  await expect(f.service.start(settings)).rejects.toMatchObject({ code: action === "close" ? "closed" : "busy" });
  await stopped;
  expect(await work).toMatchObject({ code: "cancelled" });
  expect(f.lifecycle.start).not.toHaveBeenCalled();
  if (action === "close") {
    expect(f.service.status().closed).toBe(true);
    await expect(f.service.install()).rejects.toMatchObject({ code: "closed" });
    await expect(f.service.refreshStatus()).rejects.toMatchObject({ code: "closed" });
  }
});

test("stop reaches pending lifecycle start before waiting for service work", async () => {
  const f = await fixture();
  const entered = deferred<void>(); const pending = deferred<typeof connection>();
  f.lifecycle.start.mockImplementation(() => { entered.resolve(); return pending.promise; });
  f.lifecycle.stop.mockImplementation(async () => { pending.reject(new ManagedLlamaError("start_cancelled", secret)); });
  const work = f.service.start(settings).catch(error => error);
  await entered.promise;
  await f.service.stop();
  expect(await work).toMatchObject({ code: "cancelled" });
  expect(f.lifecycle.stop).toHaveBeenCalled();
  expect(f.service.status().ownsProcess).toBe(false);
});

test("unsupported platform rejects actions without creating dependencies", async () => {
  const f = await fixture();
  const service = new ManagedLlamaService(f.root, { platform: { os: "unsupported", arch: "unit" }, createInstaller: f.createInstaller });
  services.push(service);
  expect(service.status().phase).toBe("unsupported");
  for (const work of [service.install(), service.start(settings), service.refreshStatus()])
    await expect(work).rejects.toMatchObject({ code: "unsupported_platform" });
  expect(f.createInstaller).not.toHaveBeenCalled();
});

test("unrelated private storage is rejected and its owned test sentinel is preserved", async () => {
  const f = await fixture(false);
  const storage = join(f.root, ".abot-managed-llama");
  await fs.mkdir(storage, { mode: 0o700 });
  const sentinel = join(storage, "unrelated.txt");
  await fs.writeFile(sentinel, "unit sentinel", { flag: "wx" });
  await expect(f.service.install()).rejects.toMatchObject({ code: "storage_conflict" });
  expect(f.install).not.toHaveBeenCalled();
  expect(await fs.readFile(sentinel, "utf8")).toBe("unit sentinel");
  expect(await fs.readdir(storage)).toEqual(["unrelated.txt"]);
});

test("dependency errors and arbitrary lifecycle codes are sanitized", async () => {
  const f = await fixture();
  f.inspect.mockRejectedValueOnce(new Error(secret));
  const error = await f.service.start(settings).catch(error => error);
  expect(error).toMatchObject({ code: "start_failed" });
  expect(error.message).not.toContain(secret);
  expect(JSON.stringify(f.service.status())).not.toContain(secret);
  await f.service.start(settings);
  f.lifecycle.status.mockReturnValue({ phase: "error", closed: false, ownsProcess: false, errorCode: secret } as ReturnType<typeof f.lifecycle.status>);
  expect(f.service.status().errorCode).toBe("start_failed");
});

// Node stream and response doubles only: no sockets, listening ports or browser.
const base = "runtime/managed-llama";
type RequestOptions = { method?: string; raw?: string; headers?: Record<string, string | undefined>; remote?: string; local?: string; localPort?: number };
function exchange(routes: ManagedLlamaRoutes, route: string, options: RequestOptions = {}) {
  const request = Readable.from([Buffer.from(options.raw ?? "{}")]) as unknown as IncomingMessage;
  request.headers = { host: "localhost:18444", origin: "http://localhost:18444", "content-type": "application/json", ...options.headers };
  Object.defineProperty(request, "socket", { value: { remoteAddress: options.remote ?? "127.0.0.1", localAddress: options.local ?? "127.0.0.1", localPort: options.localPort ?? 18444 } });
  const headers: Record<string, unknown> = {};
  let statusCode = 200; let text = "";
  const response = {
    setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = value; return this; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    writeHead(code: number, values?: Record<string, unknown>) { statusCode = code; if (values) for (const [key, value] of Object.entries(values)) headers[key.toLowerCase()] = value; return this; },
    get statusCode() { return statusCode; }, set statusCode(value: number) { statusCode = value; },
    end(value?: string | Buffer) { if (value) text += value.toString(); return this; },
  } as unknown as ServerResponse;
  return routes.handle({ route, method: options.method ?? "POST", request, response }).then(handled => ({ handled, statusCode, text, headers }));
}

test("status route exposes only nonsecret cached state and does not inspect disk", async () => {
  const f = await fixture();
  const routes = new ManagedLlamaRoutes(f.service);
  const initial = await exchange(routes, base + "/status", { method: "GET" });
  expect(initial.statusCode).toBe(200); expect(initial.headers["cache-control"]).toBe("no-store");
  expect(f.inspect).not.toHaveBeenCalled();
  await f.service.start(settings);
  const ready = await exchange(routes, base, { method: "GET" });
  expect(ready.statusCode).toBe(200);
  expect(ready.text).not.toContain(secret); expect(ready.text).not.toContain("apiKey");
  expect(ready.text).toContain('"phase":"ready"');
});

test.each([
  { remote: "192.0.2.1" }, { local: "192.0.2.2" }, { localPort: 12345 },
  { headers: { host: "foreign.invalid:18444" } },
  { headers: { origin: "http://foreign.invalid" } },
  { headers: { "sec-fetch-site": "cross-site" } },
])("rejects nonlocal or cross-origin requests: %j", async options => {
  const f = await fixture();
  const result = await exchange(new ManagedLlamaRoutes(f.service), base + "/install", options);
  expect(result.statusCode).toBe(403); expect(f.createInstaller).not.toHaveBeenCalled();
});

test("mutation requires JSON content type", async () => {
  const f = await fixture();
  const result = await exchange(new ManagedLlamaRoutes(f.service), base + "/install", { headers: { "content-type": "text/plain" } });
  expect(result.statusCode).toBe(415); expect(f.install).not.toHaveBeenCalled();
});

test.each([["/status", "POST", "GET"], ["/start", "GET", "POST"]])("method guard for %s", async (suffix, method, allow) => {
  const f = await fixture();
  const result = await exchange(new ManagedLlamaRoutes(f.service), base + suffix, { method });
  expect(result.statusCode).toBe(405); expect(result.headers.allow).toBe(allow);
  expect(f.createInstaller).not.toHaveBeenCalled();
});

test.each(["", "{", "null", "[]", "42", '{"unexpected":true}'])("rejects invalid install body %j", async raw => {
  const f = await fixture();
  const result = await exchange(new ManagedLlamaRoutes(f.service), base + "/install", { raw });
  expect(result.statusCode).toBe(400); expect(f.install).not.toHaveBeenCalled();
});

test.each([
  {}, { ...settings, unexpected: true }, { ...settings, port: 80 },
  { ...settings, modelPath: "relative.gguf" }, { ...settings, alias: "bad alias" },
  { ...settings, contextTokens: 1 }, { ...settings, gpuLayers: -1 },
])("rejects invalid start fields %j", async input => {
  const f = await fixture();
  const result = await exchange(new ManagedLlamaRoutes(f.service), base + "/start", { raw: JSON.stringify(input) });
  expect(result.statusCode).toBe(400); expect(f.lifecycle.start).not.toHaveBeenCalled();
});

test("oversized body is rejected and unknown routes are not claimed", async () => {
  const f = await fixture(); const routes = new ManagedLlamaRoutes(f.service);
  const large = await exchange(routes, base + "/install", { raw: JSON.stringify({ value: "x".repeat(17000) }) });
  expect(large.statusCode).toBe(413); expect(f.install).not.toHaveBeenCalled();
  const unknown = await exchange(routes, base + "/unknown");
  expect(unknown.handled).toBe(false); expect(unknown.text).toBe("");
});

test("start and stop dispatch to the single owner without serializing action secrets", async () => {
  const f = await fixture(); const routes = new ManagedLlamaRoutes(f.service);
  const started = await exchange(routes, base + "/start", { raw: JSON.stringify(settings) });
  expect(started.statusCode).toBe(200); expect(started.text).not.toContain(secret);
  expect(f.lifecycle.start).toHaveBeenCalledExactlyOnceWith(settings);
  const stopped = await exchange(routes, base + "/stop");
  expect(stopped.statusCode).toBe(200); expect(f.lifecycle.stop).toHaveBeenCalled();
  expect(f.service.status().ownsProcess).toBe(false);
});

test("cancel request reaches owner during pending install request", async () => {
  const f = await fixture(false); const routes = new ManagedLlamaRoutes(f.service);
  const entered = deferred<AbortSignal>();
  f.install.mockImplementation(signal => new Promise((_yes, no) => {
    entered.resolve(signal!); signal!.addEventListener("abort", () => no(signal!.reason), { once: true });
  }));
  const pending = exchange(routes, base + "/install");
  const signal = await entered.promise;
  const cancelled = await exchange(routes, base + "/cancel");
  expect(cancelled.statusCode).toBe(200); expect(signal.aborted).toBe(true);
  expect((await pending).statusCode).toBe(409);
});

test("route error responses do not expose dependency messages", async () => {
  const f = await fixture(); f.inspect.mockRejectedValue(new Error(secret));
  const result = await exchange(new ManagedLlamaRoutes(f.service), base + "/start", { raw: JSON.stringify(settings) });
  expect(result.statusCode).toBe(500); expect(result.text).not.toContain(secret);
  expect(result.text).toContain("start_failed");
});
