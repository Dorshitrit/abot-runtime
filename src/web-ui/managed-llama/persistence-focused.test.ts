import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedLlamaPersistence } from "./persistence.js";
import { ManagedLlamaError, type LaunchSettings } from "./contracts.js";

const settings: LaunchSettings = { modelPath: "/not-read/model.gguf", alias: "local-model", port: 8080, contextTokens: 4096, gpuLayers: 0 };
let root: string;
let directory: string;
let statePath: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "abot-persistence-test-"));
  directory = join(root, ".abot-managed-llama");
  await mkdir(directory, { mode: 0o700 });
  statePath = join(directory, "launch-state.json");
});
afterEach(async () => { await chmod(directory, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });
async function rejects(work: Promise<unknown>) {
  await expect(work).rejects.toBeInstanceOf(ManagedLlamaError);
  await expect(work).rejects.toMatchObject({ code: "persistence_unavailable", message: "Managed llama.cpp persistence unavailable." });
}
describe("private managed launch persistence", () => {
  it("constructs inertly and reads missing state without writes", async () => {
    new ManagedLlamaPersistence(join(root, "missing", ".abot-managed-llama"));
    expect(await readdir(root)).toEqual([".abot-managed-llama"]);
    expect(await new ManagedLlamaPersistence(directory).readPreferences()).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });
  it("durably preserves one key across starts, changes and fresh instances", async () => {
    const adapter = new ManagedLlamaPersistence(directory);
    const first = await adapter.prepareStart(settings);
    expect(first.apiKey).toMatch(/^[a-f0-9]{64}$/);
    expect(await adapter.prepareStart(settings)).toEqual(first);
    const changed = { ...settings, alias: "next", port: 8081 };
    expect(await new ManagedLlamaPersistence(directory).prepareStart(changed)).toEqual(first);
    const restored = await new ManagedLlamaPersistence(directory).readPreferences();
    expect(restored).toEqual(changed);
    expect(Object.keys(restored!).sort()).toEqual(Object.keys(settings).sort());
    expect(JSON.stringify(restored)).not.toContain(first.apiKey);
    expect((await lstat(statePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["launch-state.json"]);
  });
  it("serializes concurrent preparations across instances without rotating keys", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => new ManagedLlamaPersistence(directory).prepareStart({ ...settings, port: 8100 + i })));
    expect(new Set(results.map(r => r.apiKey)).size).toBe(1);
    expect(await new ManagedLlamaPersistence(directory).readPreferences()).toEqual({ ...settings, port: 8119 });
    expect(await readdir(directory)).toEqual(["launch-state.json"]);
  });
  it("waits for a cooperating first-write winner and reuses its key", async () => {
    const lock = join(directory, "launch-state.lock");
    await writeFile(lock, "", { flag: "wx", mode: 0o600 });
    const key = "ab".repeat(32);
    const operation = new ManagedLlamaPersistence(directory).prepareStart(settings);
    await new Promise(resolve => setTimeout(resolve, 30));
    await writeFile(statePath, JSON.stringify({ schema: 1, apiKey: key, preferences: { ...settings, alias: "winner" } }) + "\n", { flag: "wx", mode: 0o600 });
    await rm(lock);
    expect(await operation).toEqual({ apiKey: key });
  });
  it.each([
    { ...settings, apiKey: "not-allowed" }, { ...settings, modelPath: "relative.gguf" },
    { ...settings, modelPath: "/bad.bin" }, { ...settings, modelPath: "/bad\n.gguf" },
    { ...settings, alias: "bad alias" }, { ...settings, port: 1023 },
    { ...settings, port: 65536 }, { ...settings, contextTokens: 511 },
    { ...settings, contextTokens: 131073 }, { ...settings, gpuLayers: -1 },
    { ...settings, gpuLayers: 1000 }, { ...settings, gpuLayers: 0.5 },
  ])("rejects non-allowlisted or structurally invalid launch settings %#", async value => {
    await rejects(new ManagedLlamaPersistence(directory).prepareStart(value as LaunchSettings));
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(["{", "{}", "null", "x".repeat(32769),
    JSON.stringify({ schema: 2, apiKey: "ab".repeat(32), preferences: settings }) + "\n",
    JSON.stringify({ schema: 1, apiKey: "short", preferences: settings }) + "\n",
    JSON.stringify({ schema: 1, apiKey: "ab".repeat(32), preferences: { ...settings, secret: "bad" } }) + "\n",
    '{"schema":1,"schema":1,"apiKey":"' + "ab".repeat(32) + '","preferences":' + JSON.stringify(settings) + '}\n',
  ])("fails closed on malformed state without replacing it %#", async text => {
    await writeFile(statePath, text, { mode: 0o600 });
    const adapter = new ManagedLlamaPersistence(directory);
    await rejects(adapter.readPreferences());
    await rejects(adapter.prepareStart(settings));
    expect(await readFile(statePath, "utf8")).toBe(text);
    expect(await readdir(directory)).toEqual(["launch-state.json"]);
  });
  it("rejects unsafe file modes and never repairs or replaces", async () => {
    await new ManagedLlamaPersistence(directory).prepareStart(settings);
    const before = await readFile(statePath, "utf8");
    await chmod(statePath, 0o644);
    await rejects(new ManagedLlamaPersistence(directory).prepareStart(settings));
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect((await lstat(statePath)).mode & 0o777).toBe(0o644);
  });
  it("rejects inaccessible files without replacement", async () => {
    await new ManagedLlamaPersistence(directory).prepareStart(settings);
    await chmod(statePath, 0);
    await rejects(new ManagedLlamaPersistence(directory).readPreferences());
    await rejects(new ManagedLlamaPersistence(directory).prepareStart(settings));
    expect((await lstat(statePath)).mode & 0o777).toBe(0);
  });
  it("rejects dangling symlinks and nonregular state", async () => {
    await symlink(join(root, "absent"), statePath);
    await rejects(new ManagedLlamaPersistence(directory).prepareStart(settings));
    expect((await lstat(statePath)).isSymbolicLink()).toBe(true);
    await rm(statePath);
    await mkdir(statePath);
    await rejects(new ManagedLlamaPersistence(directory).readPreferences());
    await rejects(new ManagedLlamaPersistence(directory).prepareStart(settings));
    expect((await lstat(statePath)).isDirectory()).toBe(true);
  });
  it("does not create missing storage or adopt nonprivate/symlink directories", async () => {
    await rejects(new ManagedLlamaPersistence(join(root, "missing", ".abot-managed-llama")).prepareStart(settings));
    await chmod(directory, 0o755);
    await rejects(new ManagedLlamaPersistence(directory).prepareStart(settings));
    expect(await readdir(directory)).toEqual([]);
    await chmod(directory, 0o700);
    const alias = join(root, "alias");
    await symlink(root, alias);
    await rejects(new ManagedLlamaPersistence(join(alias, ".abot-managed-llama")).readPreferences());
  });
  it("rejects persistence lock failure and leaves foreign files untouched", async () => {
    const adapter = new ManagedLlamaPersistence(directory);
    await adapter.prepareStart(settings);
    const before = await readFile(statePath, "utf8");
    const lock = join(directory, "launch-state.lock");
    await symlink(join(root, "absent"), lock);
    await rejects(adapter.prepareStart({ ...settings, alias: "changed" }));
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect((await lstat(lock)).isSymbolicLink()).toBe(true);
  });
});
