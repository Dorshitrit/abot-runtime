import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import { assertRuntimeMaintenanceScope } from "../local-host/maintenance-scope.js";

const directories: string[] = [];
beforeEach(() => {
  for (const key of ["LLM_RUNTIME_CONFIG_FILE", "LLM_RUNTIME_DIR", "LLM_RUNTIME_SESSIONS_DIR", "LLM_RUNTIME_ATTACHMENTS_DIR", "LLM_RUNTIME_TRACE_FILE", "LLM_RUNTIME_PROFILE"])
    vi.stubEnv(key, "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const parent = resolve(".codex/artifacts/runtime-reset-spark-read-20261030/fixtures");
  await mkdir(parent, { recursive: true });
  const rootDir = await mkdtemp(join(parent, "scope-")); directories.push(rootDir);
  const source = {
    models: { providers: { local: { type: "ollama" } }, profiles: { test: { provider: "local", model: "unused", contextWindowTokens: 32768 } } },
    requestRunner: { configRef: "./runner.json" },
    environment: { default: "dev", profiles: {
      dev: { paths: { runtimeDir: ".runtime/dev", sessionsDir: ".runtime/dev/sessions", attachmentsDir: ".runtime/dev/attachments", traceFile: ".runtime/dev/logs/trace.jsonl" } },
      prod: { paths: { runtimeDir: ".runtime/prod", sessionsDir: ".runtime/prod/sessions", attachmentsDir: ".runtime/prod/attachments", traceFile: ".runtime/prod/logs/trace.jsonl" } },
    } },
  };
  await writeFile(join(rootDir, "runner.json"), JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "test", steps: {} } },
    context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 }, stepDefaults: { timeoutMs: 5000 }, steps: {},
  }));
  const save = () => writeFile(join(rootDir, "runtime.config.json"), JSON.stringify(source));
  await save();
  const load = (configPath?: string) => loadRuntimeConfig({ rootDir, profileId: "dev", configPath, env: process.env });
  return { rootDir, source, save, load };
}

test("isolated environment storage is verified without starting any owner", async () => {
  const f = await fixture();
  await expect(assertRuntimeMaintenanceScope(f.load(), "sessions")).resolves.toBeUndefined();
  await expect(assertRuntimeMaintenanceScope(f.load(), "logs")).resolves.toBeUndefined();
});

test.each(["sessionsDir", "attachmentsDir", "traceFile", "runtimeDir"] as const)("refuses a shared %s", async key => {
  const f = await fixture();
  f.source.environment.profiles.prod.paths[key] = f.source.environment.profiles.dev.paths[key]; await f.save();
  await expect(assertRuntimeMaintenanceScope(f.load(), key === "traceFile" ? "logs" : "sessions"))
    .rejects.toThrow("runtime_maintenance_shared_paths");
});

test("refuses nested attachment roots and directory aliases into another environment", async () => {
  const f = await fixture();
  f.source.environment.profiles.prod.paths.attachmentsDir = ".runtime/dev/attachments/another-environment"; await f.save();
  await expect(assertRuntimeMaintenanceScope(f.load(), "sessions")).rejects.toThrow("runtime_maintenance_shared_paths");
  f.source.environment.profiles.prod.paths.attachmentsDir = ".runtime/prod/attachments"; await f.save();
  const config = f.load();
  await mkdir(config.paths.sessionsDir, { recursive: true });
  const other = join(f.rootDir, ".runtime/prod/sessions"); await mkdir(dirname(other), { recursive: true });
  await symlink(config.paths.sessionsDir, other, "dir");
  await expect(assertRuntimeMaintenanceScope(config, "sessions")).rejects.toThrow("runtime_maintenance_shared_paths");
});

test("refuses changed configuration instead of clearing an old owner path", async () => {
  const f = await fixture(); const owner = f.load();
  f.source.environment.profiles.dev.paths.sessionsDir = ".runtime/dev/new-sessions"; await f.save();
  await expect(assertRuntimeMaintenanceScope(owner, "sessions")).rejects.toThrow("runtime_maintenance_scope_unavailable");
});

test("custom configuration is supported when its source is available to the owner", async () => {
  const f = await fixture(); const custom = join(f.rootDir, "custom.json");
  await rename(join(f.rootDir, "runtime.config.json"), custom);
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", custom);
  await expect(assertRuntimeMaintenanceScope(f.load(custom), "sessions")).resolves.toBeUndefined();
});

test("a custom source unavailable to the owner fails closed", async () => {
  const f = await fixture(); const custom = join(f.rootDir, "custom.json");
  await rename(join(f.rootDir, "runtime.config.json"), custom);
  const owner = f.load(custom);
  await expect(assertRuntimeMaintenanceScope(owner, "sessions")).rejects.toThrow("runtime_maintenance_scope_unavailable");
});

test("an environment override sharing all trace files cannot clear another environment", async () => {
  const f = await fixture(); vi.stubEnv("LLM_RUNTIME_TRACE_FILE", join(f.rootDir, "shared-trace.jsonl"));
  await expect(assertRuntimeMaintenanceScope(f.load(), "logs")).rejects.toThrow("runtime_maintenance_shared_paths");
});


test("ancestor runtime roots are allowed when their owned sidecars and conversation storage are distinct", async () => {
  const f = await fixture();
  f.source.environment.profiles.dev.paths.runtimeDir = ".runtime";
  await f.save();
  await expect(assertRuntimeMaintenanceScope(f.load(), "sessions")).resolves.toBeUndefined();
});

test("changed runtime sidecar location is refused while session and attachment roots match", async () => {
  const f = await fixture(); const owner = f.load();
  f.source.environment.profiles.dev.paths.runtimeDir = ".runtime/reconfigured"; await f.save();
  await expect(assertRuntimeMaintenanceScope(owner, "sessions")).rejects.toThrow("runtime_maintenance_scope_unavailable");
});
