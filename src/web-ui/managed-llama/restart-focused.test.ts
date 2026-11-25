import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, readdir, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { ManagedLlamaService } from "./service.js";
import { ManagedLlamaLifecycle } from "./lifecycle.js";
import { ManagedLlamaPersistence } from "./persistence.js";
import { ManagedLlamaRoutes } from "./routes.js";
import { createManagedLlamaHandoff } from "./configuration-handoff.js";
import type { LaunchSettings } from "./contracts.js";
import type { InstalledLlama } from "./install.js";

const settings: LaunchSettings = { modelPath: "/synthetic/never-read.gguf", alias: "unit", port: 18443, contextTokens: 4096, gpuLayers: 0 };
const receipt = { executable: "/synthetic/never-executed/llama-server" } as InstalledLlama;
const roots: string[] = [];
const owners: Array<{ close(): Promise<unknown> }> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function processSeams() {
  const spawn = vi.fn((_file: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
        child.signalCode = signal;
        child.emit("exit", null, signal);
        child.emit("close", null, signal);
        return true;
      }) });
    return child as unknown as ChildProcess;
  });
  const health = vi.fn(async () => true);
  const checkPort = vi.fn(async () => {});
  const validateLaunch = vi.fn(async (input: unknown) => ({ ...(input as LaunchSettings) }));
  return { spawn, health, checkPort, validateLaunch };
}
async function fixture(existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(await realpath(tmpdir()), "abot-restart-unit-"));
  const directory = join(root, ".abot-managed-llama");
  if (!existingRoot) { roots.push(root); await mkdir(directory, { mode: 0o700 }); }
  const seams = processSeams();
  const inspect = vi.fn(async () => receipt);
  const install = vi.fn(async () => { throw new Error("unexpected install"); });
  const download = vi.fn(async () => { throw new Error("unexpected download"); });
  const createInstaller = vi.fn(() => ({ inspect, install }));
  const createPersistence = vi.fn((path: string) => new ManagedLlamaPersistence(path));
  const createLifecycle = vi.fn((deps: ConstructorParameters<typeof ManagedLlamaLifecycle>[0]) => new ManagedLlamaLifecycle(deps));
  const service = new ManagedLlamaService(root, { platform: { os: "darwin", arch: "arm64" }, ...seams,
    createInstaller, createPersistence, createLifecycle, download });
  owners.push(service);
  return { root, directory, service, inspect, install, download, createInstaller, createPersistence, createLifecycle, ...seams };
}
afterEach(async () => {
  try { for (const owner of owners.splice(0)) await owner.close(); }
  finally { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); }
});
async function route(service: ManagedLlamaService, action: string, input: unknown = {}) {
  const method = action === "status" ? "GET" : "POST";
  const request = Readable.from(method === "GET" ? [] : [Buffer.from(JSON.stringify(input))]) as unknown as IncomingMessage;
  Object.assign(request, { method, url: "/api/runtime/managed-llama/" + action,
    headers: { host: "127.0.0.1:18444", origin: "http://127.0.0.1:18444", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 18444 } });
  let text = "";
  const headers = new Map<string, unknown>();
  const response = Object.assign(new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } }), {
    statusCode: 200,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    writeHead(code: number, fields?: Record<string, unknown>) { this.statusCode = code; for (const [k,v] of Object.entries(fields ?? {})) headers.set(k.toLowerCase(), v); return this; },
  });
  expect(await new ManagedLlamaRoutes(service).handle({ method, route: "runtime/managed-llama/" + action,
    request, response: response as unknown as ServerResponse })).toBe(true);
  expect(headers.get("cache-control")).toBe("no-store");
  return { code: response.statusCode, body: JSON.parse(text), text };
}
function privateFree(value: unknown, key?: string) {
  const text = JSON.stringify(value);
  expect(text).not.toContain("apiKey");
  if (key) expect(text).not.toContain(key);
}
function environmentKey(f: Awaited<ReturnType<typeof fixture>>, index: number) {
  const args = f.spawn.mock.calls[index][1];
  const key = f.spawn.mock.calls[index][2].env?.LLAMA_API_KEY;
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(args).not.toContain("--api-key");
  expect(args).not.toContain(key);
  return key!;
}

test("construction, status and explicit inspection never start or download", async () => {
  const f = await fixture();
  expect(f.service.status()).toMatchObject({ phase: "idle", ownsProcess: false, preferences: null });
  f.service.capabilities();
  for (const spy of [f.createInstaller, f.createLifecycle, f.createPersistence, f.spawn, f.download]) expect(spy).not.toHaveBeenCalled();
  expect((await route(f.service, "status")).code).toBe(200);
  expect(f.createInstaller).not.toHaveBeenCalled();
  expect((await route(f.service, "inspect")).code).toBe(200);
  expect(f.service.status()).toMatchObject({ ownsProcess: false, preferences: null });
  for (const spy of [f.createLifecycle, f.spawn, f.install, f.download, f.health, f.validateLaunch, f.checkPort]) expect(spy).not.toHaveBeenCalled();
  expect(await readdir(f.directory)).toEqual([]);
});

for (const kind of ["runtime", "models"] as const) {
  test(kind + " handoff memory snapshot retains credential across stop/start and fresh service restoration", async () => {
    const f = await fixture();
    const first = await route(f.service, "start", settings);
    expect(first.code).toBe(200);
    const key = environmentKey(f, 0);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    const body = kind === "runtime" ? { managedLlama: true, provider: "llamacpp", deferActivation: true }
      : { managedLlama: true, profileId: "unit-profile", newProvider: { id: "unit-provider", type: "llamacpp" } };
    // Private save-path snapshot only. No actual provider file save is performed.
    const savedInMemory = structuredClone(createManagedLlamaHandoff(kind, () => f.service.readyConnectionForConfiguration())(body));
    expect(savedInMemory.apiKey).toBe(key);
    privateFree(first.body, key);
    privateFree(f.service.status(), key);
    privateFree((await route(f.service, "status")).body, key);
    expect(f.service.status().preferences).toEqual(settings);
    expect(Object.keys(f.service.status().preferences!).sort()).toEqual(Object.keys(settings).sort());
    expect((await route(f.service, "stop")).code).toBe(200);
    expect(f.service.readyConnectionForConfiguration()).toBeNull();
    expect((await route(f.service, "start", settings)).code).toBe(200);
    expect(environmentKey(f, 1)).toBe(savedInMemory.apiKey);
    expect(createManagedLlamaHandoff(kind, () => f.service.readyConnectionForConfiguration())(body).apiKey).toBe(key);
    await f.service.close();
    const fresh = await fixture(f.root);
    expect(fresh.service.status()).toMatchObject({ phase: "idle", ownsProcess: false, preferences: null });
    const inspected = await route(fresh.service, "inspect");
    expect(inspected.code).toBe(200);
    expect(inspected.body.status.preferences).toEqual(settings);
    expect(inspected.body.status.ownsProcess).toBe(false);
    expect(fresh.service.readyConnectionForConfiguration()).toBeNull();
    for (const spy of [fresh.spawn, fresh.install, fresh.download, fresh.createLifecycle]) expect(spy).not.toHaveBeenCalled();
    privateFree(inspected.body, key);
    const restarted = await route(fresh.service, "start", inspected.body.status.preferences);
    expect(restarted.code).toBe(200);
    expect(environmentKey(fresh, 0)).toBe(savedInMemory.apiKey);
    expect(createManagedLlamaHandoff(kind, () => fresh.service.readyConnectionForConfiguration())(body).apiKey).toBe(savedInMemory.apiKey);
    privateFree(restarted.body, key);
    privateFree((await route(fresh.service, "status")).body, key);
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(fresh.spawn).toHaveBeenCalledTimes(1);
    for (const owner of [f, fresh]) { expect(owner.install).not.toHaveBeenCalled(); expect(owner.download).not.toHaveBeenCalled(); }
  });
}

test.each(["malformed", "unsafe-mode"] as const)("%s persisted state fails closed before spawn with sanitized 503", async variant => {
  const f = await fixture();
  const path = join(f.directory, "launch-state.json");
  const key = "ab".repeat(32);
  const text = variant === "malformed" ? '{broken-private-detail-' + key
    : JSON.stringify({ schema: 1, apiKey: key, preferences: settings }) + "\n";
  await writeFile(path, text, { flag: "wx", mode: 0o600 });
  if (variant === "unsafe-mode") await chmod(path, 0o644);
  for (const action of ["inspect", "start"]) {
    const result = await route(f.service, action, action === "start" ? settings : {});
    expect(result.code).toBe(503);
    expect(result.body).toEqual({ ok: false, error: "persistence_unavailable", message: "The managed llama.cpp operation could not be completed." });
    privateFree(result.body, key);
    expect(result.text).not.toContain(f.root);
    privateFree(f.service.status(), key);
    expect(f.service.readyConnectionForConfiguration()).toBeNull();
  }
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.health).not.toHaveBeenCalled();
  expect(f.download).not.toHaveBeenCalled();
  expect(f.install).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe(text);
  expect(await readdir(f.directory)).toEqual(["launch-state.json"]);
});

test("stop during pending credential resolution fences late spawn even when resolver ignores abort", async () => {
  const seams = processSeams();
  const entered = deferred<AbortSignal>();
  const release = deferred<string>();
  const resolver = vi.fn(async (_settings: LaunchSettings, signal: AbortSignal) => { entered.resolve(signal); return release.promise; });
  const lifecycle = new ManagedLlamaLifecycle({ ...seams, installer: { inspect: async () => receipt }, resolveCredential: resolver });
  owners.push(lifecycle);
  const work = lifecycle.start(settings).catch(error => error);
  const signal = await entered.promise;
  try {
    await lifecycle.stop();
    expect(signal.aborted).toBe(true);
    expect(await work).toMatchObject({ code: "start_cancelled" });
    expect(lifecycle.status()).toMatchObject({ phase: "stopped", ownsProcess: false });
  } finally { release.resolve("cd".repeat(32)); }
  await new Promise(resolve => setImmediate(resolve));
  expect(seams.spawn).not.toHaveBeenCalled();
  expect(seams.health).not.toHaveBeenCalled();
  expect(lifecycle.readyConnection()).toBeNull();
  privateFree(lifecycle.status(), "cd".repeat(32));
});
