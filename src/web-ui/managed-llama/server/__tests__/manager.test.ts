import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import { privateRoot, serverSettings } from "./fixtures.js";
import { ManagedLlamaServerManager, type ServerManagerDependencies } from "../manager.js";
import type { ManagedLlamaService } from "../../service.js";
import { RELEASES } from "../../release.js";
import { serverFailure } from "../settings.js";
import { createManagedLlamaHandoff } from "../../configuration-handoff.js";
import { managedEmbeddingHandoff } from "../embedding-handoff.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function settle() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });
async function fixture(startup: "manual" | "with-abot" = "manual", embedding = false) {
  const root = await privateRoot(), settings = serverSettings(root);
  settings.startup = startup;
  if (embedding) settings.embedding = { ...settings.models[0]!, alias: "embed", port: 18081, pooling: "mean", batchTokens: 512 };
  let saved = { schema: 1 as const, revision: "a".repeat(32), apiKey: "b".repeat(64), settings };
  const engineState = { phase: "idle", installation: "installed", ownsProcess: false };
  const engine = { status: () => engineState as ReturnType<ManagedLlamaService["status"]>,
    capabilities: () => ({ supported: true, cpuOnly: false, release: RELEASES.arm64 }) as ReturnType<ManagedLlamaService["capabilities"]>,
    install: vi.fn(async () => engineState as ReturnType<ManagedLlamaService["status"]>),
    refreshStatus: vi.fn(async () => engineState as ReturnType<ManagedLlamaService["status"]>),
    cancel: vi.fn(async () => {}) };
  const store = { read: vi.fn(async () => saved), save: vi.fn(async (next, revision) => {
    if (revision !== saved.revision) throw serverFailure("server_settings_changed");
    saved = { ...saved, revision: "c".repeat(32), settings: next }; return saved;
  }) };
  const owners: ReturnType<typeof owner>[] = [];
  function owner() {
    let owns = false, ready = false;
    const connection = { baseUrl: "http://127.0.0.1:18080", model: "chat:one", contextWindowTokens: 4096, apiKey: saved.apiKey };
    return { start: vi.fn(async (_input: unknown) => { owns = true; ready = true; return connection; }),
      stop: vi.fn(async () => { owns = false; ready = false; }),
      close: vi.fn(async () => { owns = false; ready = false; }),
      readyConnection: () => ready ? connection : null,
      status: () => ({ phase: ready ? "ready" as const : "stopped" as const, closed: false, ownsProcess: owns }) };
  }
  const dependencies: ServerManagerDependencies = { createStore: () => store,
    validateModels: vi.fn(async input => input),
    createPresets: vi.fn(async () => ({ path: root + "/models.ini", cache: root, remove: vi.fn(async () => {}) })),
    createLifecycle: vi.fn(() => { const result = owner(); owners.push(result); return result; }),
    observe: vi.fn(async () => [{ alias: "chat:one", state: "sleeping" as const }]) };
  const manager = new ManagedLlamaServerManager(root, engine, dependencies);
  cleanups.push(async () => { for (const o of owners) o.close.mockReset().mockImplementation(o.stop); await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, dependencies, store, engine, engineState, settings, owners };
}
test("manual restore and status are inert; explicit start/stop preserves startup and credential revision", async () => {
  const f = await fixture(); await f.manager.initialize(); await f.manager.observe();
  expect(f.dependencies.createLifecycle).not.toHaveBeenCalled(); expect(f.store.save).not.toHaveBeenCalled();
  await f.manager.start(); expect(f.manager.status()).toMatchObject({ phase: "ready", ownsProcess: true });
  const connection = f.manager.connection("chat:one")!;
  expect(connection.revision).toBe("a".repeat(32)); expect(JSON.stringify(f.manager.status())).not.toContain(connection.apiKey);
  await f.manager.observe(); expect(f.manager.status().models).toEqual([{ alias: "chat:one", state: "sleeping" }]);
  await f.manager.stop(); expect(f.manager.connection("chat:one")).toBeNull();
  expect(f.manager.status().settings?.startup).toBe("manual"); expect(f.store.save).not.toHaveBeenCalled();
});
test("saved automatic startup happens once; stopped server stays stopped until explicitly restarted", async () => {
  const f = await fixture("with-abot"); await f.manager.initialize(); await f.manager.initialize();
  expect(f.owners).toHaveLength(1); await f.manager.stop(); await f.manager.initialize(); await f.manager.observe();
  expect(f.owners).toHaveLength(1); expect(f.manager.status().settings?.startup).toBe("with-abot");
});
test("configuration validates without launching and stale revisions cannot replace it", async () => {
  const f = await fixture(); await f.manager.initialize();
  await f.manager.configure({ ...f.settings, startup: "with-abot", sleepIdleSeconds: -1 }, "a".repeat(32));
  expect(f.dependencies.createLifecycle).not.toHaveBeenCalled();
  await expect(f.manager.configure(f.settings, "a".repeat(32))).rejects.toMatchObject({ code: "server_settings_changed" });
  expect(f.manager.status().settings?.sleepIdleSeconds).toBe(-1);
});
test("stop during validation fences a late launch, including permanent application close", async () => {
  const f = await fixture(), wait = deferred<typeof f.settings>();
  f.dependencies.validateModels = vi.fn(() => wait.promise);
  const start = f.manager.start().catch(error => error); await settle();
  const stop = f.manager.close(); wait.resolve(f.settings); await stop;
  expect(await start).toMatchObject({ code: "cancelled" }); expect(f.dependencies.createLifecycle).not.toHaveBeenCalled();
  await expect(f.manager.start()).rejects.toMatchObject({ code: "closed" });
});
test("embedding startup failure stops the already running router and leaves no usable binding", async () => {
  const f = await fixture("manual", true), factory = f.dependencies.createLifecycle!;
  f.dependencies.createLifecycle = deps => {
    const result = factory(deps);
    if (f.owners.length === 2) f.owners[1]!.start.mockRejectedValue(serverFailure("port_unavailable"));
    return result;
  };
  await expect(f.manager.start()).rejects.toMatchObject({ code: "port_unavailable" });
  expect(f.owners[0]!.close).toHaveBeenCalled(); expect(f.manager.status().ownsProcess).toBe(false);
  expect(f.manager.embeddingConnection()).toBeNull(); expect(f.manager.connection("chat:one")).toBeNull();
});
test("unconfirmed termination keeps ownership and blocks another start", async () => {
  const f = await fixture(); await f.manager.start();
  f.owners[0]!.close.mockRejectedValue(serverFailure("termination_unconfirmed"));
  await expect(f.manager.stop()).rejects.toMatchObject({ code: "termination_unconfirmed" });
  expect(f.manager.status().ownsProcess).toBe(true);
  await expect(f.manager.start()).rejects.toMatchObject({ code: "busy" });
  f.owners[0]!.close.mockImplementation(f.owners[0]!.stop); await f.manager.stop();
  expect(f.manager.status().ownsProcess).toBe(false);
});
test("legacy ownership blocks mutations and startup errors remain bounded", async () => {
  const f = await fixture(); f.engineState.ownsProcess = true;
  await expect(f.manager.start()).rejects.toMatchObject({ code: "busy" });
  expect(f.store.read).not.toHaveBeenCalled();
  f.engineState.ownsProcess = false; f.store.read.mockRejectedValue(new Error("private path/key"));
  await f.manager.initialize(); expect(f.manager.status().errorCode).toBe("managed_server_failed");
  expect(JSON.stringify(f.manager.status())).not.toContain("private path/key");
});
test("provider and embedding handoffs require the saved revision and explicit model selection", async () => {
  const f = await fixture("manual", true); await f.manager.start();
  const handoff = createManagedLlamaHandoff("runtime", alias => f.manager.connection(alias));
  const input = { provider: "llamacpp", model: "chat:one", baseUrl: "http://127.0.0.1:18080", contextWindowTokens: 4096,
    managedLlama: true, managedLlamaRevision: "a".repeat(32) };
  expect(handoff(input)).toHaveProperty("apiKey", "b".repeat(64));
  expect(() => handoff({ ...input, managedLlamaRevision: "stale" })).toThrow();
  const embed = managedEmbeddingHandoff(f.manager), request = { provider: "llamacpp", model: "embed", baseUrl: "http://127.0.0.1:18081",
    managedLlamaEmbedding: true, managedLlamaRevision: input.managedLlamaRevision, memoryOptions: { emitClientEvents: true } };
  expect(embed(request)).toMatchObject({ apiKey: "b".repeat(64), memoryOptions: request.memoryOptions });
  expect(embed(request)).not.toHaveProperty("managedLlamaRevision");
  expect(() => embed({ ...request, providerId: "external" })).toThrow();
  await f.manager.stop(); expect(() => embed(request)).toThrow();
});
