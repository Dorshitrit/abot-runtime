import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { clearRuntimeTraceFiles } from "../observability/log-reset.js";
import { ProcessDebugLogger } from "../observability/debug-logger.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const parent = resolve(".codex/artifacts/runtime-reset-spark-read-20261030/fixtures");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "logs-")); directories.push(directory);
  const path = join(directory, "runtime-debug.jsonl");
  const rotation = join(directory, "runtime-debug.2026-10-30T10-00-00-000Z.jsonl");
  const shared = join(directory, "shared");
  await writeFile(path, "old active"); await writeFile(rotation, "old rotated");
  return { directory, path, rotation, shared };
}

test("clears the exact active and rotated family while preserving unrelated log files and directories", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "other.jsonl"), "preserved");
  await writeFile(join(f.directory, "runtime-debug.backup.jsonl"), "preserved");
  await mkdir(join(f.directory, "subfolder"));
  expect(await clearRuntimeTraceFiles(f.path, f.shared)).toEqual({ complete: true, clearedFiles: 2, removedRotatedFiles: 1 });
  expect(await readFile(f.path, "utf8")).toBe("");
  expect((await readdir(f.directory)).sort()).toEqual(["other.jsonl", "runtime-debug.backup.jsonl", "runtime-debug.jsonl", "subfolder"]);
});

test.each(["active", "rotated", "directory", "hardlink"] as const)("refuses %s links before clearing any original bytes", async kind => {
  const f = await fixture(); const victim = join(f.directory, "victim.txt"); await writeFile(victim, "precious");
  if (kind === "active") { await rm(f.path); await symlink(victim, f.path); }
  if (kind === "rotated") { await rm(f.rotation); await symlink(victim, f.rotation); }
  if (kind === "hardlink") { await rm(f.path); await link(victim, f.path); }
  let selected = f.path;
  if (kind === "directory") {
    const alias = `${f.directory}-alias`; directories.push(alias);
    await symlink(f.directory, alias, "dir"); selected = join(alias, "runtime-debug.jsonl");
  }
  await expect(clearRuntimeTraceFiles(selected, f.shared)).rejects.toThrow("runtime_log_reset_unsafe_path");
  expect(await readFile(victim, "utf8")).toBe("precious");
  if (kind !== "rotated") expect(await readFile(f.rotation, "utf8")).toBe("old rotated");
});

test("shared logs are never erased by an environment clear", async () => {
  const f = await fixture();
  await expect(clearRuntimeTraceFiles(f.path, f.directory)).rejects.toThrow("runtime_maintenance_shared_paths");
  expect(await readFile(f.path, "utf8")).toBe("old active");
});

test("clear is ordered between old queued trace writes and new events", async () => {
  const f = await fixture();
  vi.stubEnv("LLM_RUNTIME_TRACE_FILE", f.path); vi.stubEnv("LLM_RUNTIME_TRACE", "1");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const logger = new ProcessDebugLogger();
  logger.trace("test", "before-clear");
  const reset = logger.clear(f.path, f.shared);
  logger.trace("test", "after-clear");
  expect((await reset).complete).toBe(true); await logger.drain();
  const raw = await readFile(f.path, "utf8");
  expect(raw).toContain("after-clear"); expect(raw).not.toContain("before-clear"); expect(raw).not.toContain("old active");
});


test("a rejected clear reports failure without poisoning the logger queue", async () => {
  const f = await fixture();
  vi.stubEnv("LLM_RUNTIME_TRACE_FILE", f.path); vi.stubEnv("LLM_RUNTIME_TRACE", "1");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const logger = new ProcessDebugLogger();
  await expect(logger.clear(f.path, f.directory)).rejects.toThrow("runtime_maintenance_shared_paths");
  await expect(logger.drain()).resolves.toBeUndefined();
  logger.trace("test", "after-failed-clear"); await logger.drain();
  const raw = await readFile(f.path, "utf8");
  expect(raw).toContain("old active"); expect(raw).toContain("after-failed-clear");
});


test("shared directory aliases cannot hide a shared log from the scope guard", async () => {
  const f = await fixture();
  const alias = `${f.directory}-shared`; directories.push(alias);
  await symlink(f.directory, alias, "dir");
  await expect(clearRuntimeTraceFiles(f.path, alias)).rejects.toThrow("runtime_maintenance_shared_paths");
  expect(await readFile(f.path, "utf8")).toBe("old active");
  expect(await readFile(f.rotation, "utf8")).toBe("old rotated");
});
