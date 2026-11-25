import { afterEach, expect, test, vi } from "vitest";
import { execFile, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { channel } from "node:diagnostics_channel";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedLlamaService } from "./service.js";
import { LlamaInstaller } from "./install.js";
import { ManagedLlamaPersistence } from "./persistence.js";
import { canonicalManagedDirectory, createPrivateManagedDirectory } from "./host-files.js";
import { zipFixture, tarFixture } from "./__tests__/archive-fixture.js";

const roots: string[] = [], services: ManagedLlamaService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const path = await mkdtemp(join(await realpath(tmpdir()), "abot-managed-native-"));
  roots.push(path); return path;
}
async function installAndReopenNativeService() {
  const directory = await root(), windows = process.platform === "win32";
  const bytes = windows ? await zipFixture() : tarFixture(process.platform === "linux");
  const release = { tag: "fixture", name: windows ? "fixture.zip" : "fixture.tar.gz", url: "https://example.invalid/fixture",
    size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const modelPath = join(directory, "מודל with spaces.gguf");
  const model = Buffer.alloc(24); model.write("GGUF"); model.writeUInt32LE(3, 4);
  await writeFile(modelPath, model);
  const spawn = vi.fn((_file: string, _args: string[], _options: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals) { child.signalCode = signal; queueMicrotask(() => child.emit("exit", null, signal)); return true; } });
    return child as unknown as ChildProcess;
  });
  const create = () => {
    const service = new ManagedLlamaService(directory, {
      // Use the host filesystem and real validator/persistence. No engine is run.
      createInstaller: path => new LlamaInstaller(path, release, async () => (async function* () { yield bytes; })()),
      spawn, health: async () => true, checkPort: async () => {},
    });
    services.push(service); return service;
  };
  const first = create();
  expect((await first.install()).installation).toBe("installed");
  const preferences = { modelPath, alias: "native-fixture", port: 18443, contextTokens: 1024, gpuLayers: 0 };
  expect((await first.start(preferences)).phase).toBe("ready");
  const key = first.readyConnectionForConfiguration()!.apiKey;
  expect(spawn.mock.calls[0]![2].env!.LLAMA_API_KEY).toBe(key);
  expect(spawn.mock.calls[0]![1]).not.toContain(key);
  await first.close();
  const fresh = create();
  expect(spawn).toHaveBeenCalledOnce();
  expect((await fresh.refreshStatus()).preferences).toEqual(preferences);
  expect(spawn).toHaveBeenCalledOnce();
  expect((await fresh.start(preferences)).phase).toBe("ready");
  expect(fresh.readyConnectionForConfiguration()!.apiKey).toBe(key);
  await fresh.stop();
  expect(fresh.status().ownsProcess).toBe(false);
}
test("native install, launch preferences and stable key survive a fresh service without autostart", async () => {
  const failures = channel("abot.managed-llama.windows-storage-failure");
  const diagnostics: unknown[] = [];
  const collect = (value: unknown) => { diagnostics.push(value); };
  failures.subscribe(collect);
  try {
    await installAndReopenNativeService();
  } catch (error) {
    throw new Error("Native managed storage diagnostics: " + JSON.stringify(diagnostics), { cause: error });
  } finally {
    failures.unsubscribe(collect);
  }
}, 180_000);

test("native storage rejects directory aliases", async () => {
  const directory = await root(), target = join(directory, "private"), alias = join(directory, "alias");
  await createPrivateManagedDirectory(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(canonicalManagedDirectory(alias, true)).rejects.toThrow();
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows rejects a broadened state ACL without repairing or rotating its credential", async () => {
  const directory = join(await root(), ".abot-managed-llama");
  await createPrivateManagedDirectory(directory);
  const store = new ManagedLlamaPersistence(directory);
  await store.prepareStart({ modelPath: "C:\\fixture.gguf", alias: "unit", port: 8080, contextTokens: 1024, gpuLayers: 0 });
  const path = join(directory, "launch-state.json"), before = await readFile(path);
  await promisify(execFile)("icacls.exe", [path, "/grant", "*S-1-1-0:R"], { windowsHide: true, timeout: 10_000 });
  await expect(store.readPreferences()).rejects.toMatchObject({ code: "persistence_unavailable" });
  expect(await readFile(path)).toEqual(before);
}, 90_000);
