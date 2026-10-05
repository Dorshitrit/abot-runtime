import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import { createAutomationPersistence } from "../automations/persistence.js";
import { createAutomationResultStore } from "../automations/result-store.js";
import { createAutomationRuntimeExecutor } from "../automations/runtime-executor.js";
import { createAutomationToolLifetimes } from "../automations/tool-lifetimes.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { createRuntimeApplication } from "../composition.js";
import type { RuntimeConfig, RuntimePaths } from "../ports.js";
import * as debug from "../observability/debug-logger.js";
import { createSchedulerRuntimeFixture, createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const origin = { kind: "automation_node_v1" as const, automationId: "automation", runId: "run",
  nodeId: "node", attemptId: "attempt" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "automation-session-startup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths: RuntimePaths = { rootDir: root, runtimeDir: join(root, "runtime"),
    sessionsDir: join(root, "sessions"), attachmentsDir: join(root, "attachments"),
    agentWorkDir: join(root, "work"), workspaceDir: join(root, "workspace"),
    sharedDir: join(root, "shared"), compiledDir: join(root, "compiled"), traceFile: join(root, "trace.jsonl") };
  const original = createFileSessionStore({ sessionsDir: paths.sessionsDir });
  await original.createAutomationSession!("orphan", origin);
  const sessions = createFileSessionStore({ sessionsDir: paths.sessionsDir });
  const attachments = createFileAttachmentStore({ attachmentsDir: paths.attachmentsDir });
  const directory = join(paths.runtimeDir, "scheduler");
  const store = createFileSchedulerStore(directory);
  const execute = vi.fn(async () => { throw new Error("unexpected_dispatch"); });
  const executor = createAutomationRuntimeExecutor({ config: { paths } as RuntimeConfig,
    sessions, attachments, persistence: createAutomationPersistence(store),
    results: createAutomationResultStore(paths.runtimeDir),
    toolLifetimes: createAutomationToolLifetimes(), execute });
  const onError = vi.fn();
  const service = createSchedulerService({ environmentId: "dev", store, onError,
    tickIntervalMs: 1_000_000,
    executor: { sessionExists: async () => true, tryReserve: () => null, start: execute },
    automationExecutor: { ...executor, tryReserve: () => null } });
  cleanups.push(() => service.stop());
  return { paths, directory, sessions, attachments, executor, service, execute, onError,
    raw: () => readFile(join(paths.sessionsDir, "orphan.json"), "utf8") };
}

test("startup recovery holds the exclusive scheduler lease and finishes before management or dispatch", async () => {
  const f = await fixture();
  const entered = createSchedulerTestGate();
  const resume = createSchedulerTestGate();
  const reconcile = f.sessions.reconcileAutomationSessions!;
  vi.spyOn(f.sessions, "reconcileAutomationSessions").mockImplementationOnce(async (...args) => {
    await expect(createFileSchedulerStore(f.directory).acquire()).rejects.toThrow("scheduler_store_in_use");
    entered.open(); await resume.waiting;
    await reconcile(...args);
  });
  const starting = f.service.start();
  await entered.waiting;
  let listed = false;
  const listing = f.service.listAutomationJobs().then((jobs) => { listed = true; return jobs; });
  await Promise.resolve();
  expect(listed).toBe(false);
  expect(f.execute).not.toHaveBeenCalled();
  resume.open();
  await starting;
  expect(await listing).toEqual([]);
  await expect(f.raw()).rejects.toMatchObject({ code: "ENOENT" });
});

test("a failed injected recovery hook is observable and does not disable scheduler startup", async () => {
  const f = await fixture();
  await f.service.stop();
  const failure = new Error("injected_cleanup_unavailable");
  const executor = { ...f.executor, tryReserve: () => null,
    reconcileSessions: async () => { throw failure; } };
  const service = createSchedulerService({ environmentId: "dev",
    store: createFileSchedulerStore(f.directory), onError: f.onError,
    tickIntervalMs: 1_000_000,
    executor: { sessionExists: async () => true, tryReserve: () => null, start: f.execute },
    automationExecutor: executor });
  cleanups.push(() => service.stop());
  await expect(service.start()).resolves.toBeUndefined();
  expect(f.onError).toHaveBeenCalledExactlyOnceWith(failure);
  await expect(service.createAutomationJob({ automationId: "new", definitionRevision: 1,
    title: "Available", timeZone: "UTC", schedule: { kind: "manual" } })).resolves.toMatchObject({ state: "paused" });
  await expect(f.raw()).resolves.toBeDefined();
});

test("stopping during cleanup prevents stale startup from reactivating and releases ownership", async () => {
  const f = await fixture();
  const entered = createSchedulerTestGate();
  const resume = createSchedulerTestGate();
  vi.spyOn(f.sessions, "reconcileAutomationSessions").mockImplementationOnce(async () => {
    entered.open(); await resume.waiting;
  });
  const starting = f.service.start();
  await entered.waiting;
  const stopping = f.service.stop();
  resume.open(); await starting; await stopping;
  await expect(f.service.listAutomationJobs()).rejects.toThrow("scheduler_not_started");
  const release = await createFileSchedulerStore(f.directory).acquire();
  await release();
  expect(f.execute).not.toHaveBeenCalled();
});

test("cleanup failures remain discoverable and existing throttled maintenance retries them", async () => {
  const f = await fixture();
  const trace = vi.spyOn(debug, "traceDebug").mockImplementation(() => undefined);
  const failure = new Error("attachments_busy");
  const remove = vi.spyOn(f.attachments, "deleteSessionAttachments")
    .mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
  await f.service.start();
  await expect(f.raw()).resolves.toBeDefined();
  expect(trace).toHaveBeenCalledWith("runtime.automations", "agent_session.recovery_failed",
    { sessionId: "orphan", error: "attachments_busy" });
  await expect(f.service.listAutomationJobs()).resolves.toEqual([]);
  await f.executor.maintainRetention!(0);
  await f.executor.maintainRetention!(299_999);
  expect(remove).toHaveBeenCalledTimes(2);
  await expect(f.raw()).resolves.toBeDefined();
  await f.executor.maintainRetention!(300_000);
  expect(remove).toHaveBeenCalledTimes(3);
  await expect(f.raw()).rejects.toMatchObject({ code: "ENOENT" });
});

test("lazy automation tool startup also reconciles persisted internal sessions", async () => {
  const f = await createSchedulerRuntimeFixture();
  cleanups.push(f.dispose);
  await f.application.stop();
  const backing = createFileSessionStore({ sessionsDir: f.config.paths.sessionsDir });
  await backing.createAutomationSession!("crashed-attempt", origin);
  const application = createRuntimeApplication(f.config, { models: { invoke: f.invoke, invokeRaw: f.invokeRaw } });
  cleanups.push(() => application.stop());
  // No application.start: the model tool enters the canonical ready/ensureStarted boundary.
  const result = await application.services.tools.execute({ tool: "automations", params: { action: "list_drafts" } });
  expect(result.ok).toBe(true);
  await expect(readFile(join(f.config.paths.sessionsDir, "crashed-attempt.json"), "utf8"))
    .rejects.toMatchObject({ code: "ENOENT" });
  expect((await application.services.sessions.getSessionById("session"))?.messages).toHaveLength(2);
  expect(f.invoke).not.toHaveBeenCalled();
});
