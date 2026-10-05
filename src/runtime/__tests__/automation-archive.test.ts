import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type {
  PreparedAutomationOccurrence, SchedulerAutomationExecutor,
  SchedulerAutomationJob, SchedulerAutomationRun,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { makeAutomationSchedulerRun } from "../scheduler/automation-run-records.js";
import { createAutomationPersistence } from "../automations/persistence.js";
import { createAutomationService } from "../automations/service.js";
import type { AutomationResultStore } from "../automations/result-store.js";
import { parseAutomationStoredRecord } from "../automations/storage-records.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "automation-archive-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = createFileSchedulerStore(directory);
  let now = Date.parse("2026-09-29T08:00:00.000Z");
  function ready(job: SchedulerAutomationJob): Extract<PreparedAutomationOccurrence, { kind: "ready" }> {
    return {
      kind: "ready", inputIds: [],
      commit(state, runId) {
        state.executions.push({
          id: runId, automationId: job.target.automationId,
          definitionRevision: job.target.definitionRevision,
          revision: 1, inputIds: [], nodes: [],
        });
      },
    };
  }
  const prepare = vi.fn<SchedulerAutomationExecutor["prepare"]>(
    async (job) => ready(job));
  const prepareReplay = vi.fn<NonNullable<SchedulerAutomationExecutor["prepareReplay"]>>(
    async (job) => {
      const prepared = ready(job);
      if (prepared.kind !== "ready") throw new Error("fixture_not_ready");
      return prepared;
    });
  const start = vi.fn<SchedulerAutomationExecutor["start"]>();
  const scheduler = createSchedulerService({
    environmentId: "dev", store, now: () => now, tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async () => true, tryReserve: () => null,
      start: vi.fn(),
    },
    automationExecutor: {
      prepare, prepareReplay, start, tryReserve: () => null,
      stop: vi.fn(), cancelPending: vi.fn(), settle: vi.fn(), recover: vi.fn(),
    },
  });
  cleanups.push(() => scheduler.stop());
  await scheduler.start();
  const persistence = createAutomationPersistence(store);
  const studio = createAutomationService({
    config: { runtimeId: "dev" } as RuntimeConfig, scheduler, persistence,
    tools: { listNormalInvocations: () => [{
      toolName: "archive_fixture",
      definition: { name: "archive_fixture", params: {}, executionEffect: "read_only" },
      contract: { version: 1, operations: [{
        operationId: "read", summary: "Fixture read", effect: "read_only",
        approval: "request_policy",
        input: { type: "object", additionalProperties: false, properties: {}, required: [] },
      }] },
    }] } as unknown as ToolRegistry, results: {} as AutomationResultStore,
  });
  const draft = await studio.create("Keep this automation");
  const job = await scheduler.createAutomationJob({
    automationId: draft.automationId, definitionRevision: draft.revision,
    title: draft.definition.title, timeZone: "UTC",
    schedule: { kind: "interval", everyMs: 60_000 },
  }, (state) => {
    state.definitions.push({
      id: "published", automationId: draft.automationId, revision: draft.revision,
      definition: structuredClone(draft.definition), publishedAt: new Date(now).toISOString(),
    });
    state.grants.push({
      id: "grant", automationId: draft.automationId, environmentId: "dev",
      grantRevision: 1, mode: "full_access", operations: [],
      evidence: { kind: "authenticated_user_action", actionId: "grant-action",
        at: new Date(now).toISOString() },
    });
  });
  async function seedRun(status: SchedulerAutomationRun["status"]) {
    const run = {
      ...makeAutomationSchedulerRun(job, "existing-run", new Date(now).toISOString(), "manual", "existing-key"),
      status,
      ...(status === "succeeded" ? {
        reportRef: "kept-report", finishedAt: new Date(now).toISOString(),
      } : {}),
    };
    await persistence.updateWithScheduler((state, automations) => {
      state.runs.push(run);
      automations.executions.push({
        id: run.id, automationId: draft.automationId, definitionRevision: draft.revision,
        revision: 1, inputIds: [], nodes: [], reportRef: "kept-report",
      });
      automations.results.push({
        id: "kept-report", runId: run.id, kind: "report", storageRef: "saved-report",
        digest: "sha256:kept", sizeBytes: 12, createdAt: new Date(now).toISOString(),
      });
    });
    return run;
  }
  return {
    store, directory, scheduler, persistence, studio, draft, job,
    prepare, prepareReplay, start, ready, seedRun,
    advance: () => { now += 60_000; },
  };
}

describe("automation archive lifecycle", () => {
  it("persists archive without changing content or retained evidence; restore stays paused", async () => {
    const f = await fixture();
    await f.seedRun("succeeded");
    await f.scheduler.resumeAutomationJob(f.job.id);
    const before = await f.persistence.read();
    expect(before.drafts[0]).not.toHaveProperty("archivedAt");
    const archived = await f.studio.archive(f.draft.automationId, f.draft.revision);
    expect(archived).toMatchObject({ revision: f.draft.revision, archivedAt: expect.any(String) });
    expect(archived.definition).toEqual(f.draft.definition);
    expect(await f.studio.list()).toMatchObject([{ status: "archived" }]);
    const reopened = createFileSchedulerStore(f.directory);
    expect((await reopened.readAutomations!()).drafts[0]).toEqual(archived);
    expect((await reopened.read()).jobs[0]).toMatchObject({ state: "paused", nextRunAt: null });
    const archivedState = await f.persistence.read();
    for (const collection of ["definitions", "grants", "executions", "results"] as const)
      expect(archivedState[collection]).toEqual(before[collection]);
    expect(await f.studio.archive(f.draft.automationId, f.draft.revision)).toEqual(archived);
    const restored = await f.studio.restore(f.draft.automationId, f.draft.revision);
    expect(restored).not.toHaveProperty("archivedAt");
    expect(restored.definition).toEqual(f.draft.definition);
    expect(await f.studio.list()).toMatchObject([{ status: "paused" }]);
    expect((await reopened.readAutomations!()).drafts[0]).not.toHaveProperty("archivedAt");
    expect(await f.studio.restore(f.draft.automationId, f.draft.revision)).toEqual(restored);
    f.advance();
    await f.scheduler.tick();
    expect(f.prepare).not.toHaveBeenCalled();
    await f.studio.activate(f.draft.automationId);
    expect(await f.scheduler.getAutomationJob(f.draft.automationId))
      .toMatchObject({ state: "active", nextRunAt: expect.any(String) });
  });

  it("reopens archived legacy drafts, restores, edits and republishes with monotonic storage revisions", async () => {
    const f = await fixture();
    const archived = await f.studio.archive(f.draft.automationId, f.draft.revision);
    expect(archived.storageRevision).toBe(2);
    await f.scheduler.stop();
    await f.scheduler.start();
    expect(await f.studio.getDraft(f.draft.automationId)).toEqual(archived);
    const restored = await f.studio.restore(f.draft.automationId, f.draft.revision);
    expect(restored.storageRevision).toBe(3);
    const edited = await f.studio.updateDraft(f.draft.automationId, restored.revision, {
      kind: "add_node", parentSequenceId: restored.definition.body.id, index: 0,
      nodeWithoutId: {
        kind: "tool", title: "Read fixture", onFailure: "stop",
        operation: { toolName: "archive_fixture", operationId: "read", contractVersion: 1 },
        controls: {},
      },
    });
    expect(edited).toMatchObject({ revision: 2, storageRevision: 4 });
    await f.studio.replaceGrant({
      automationId: f.draft.automationId, expectedGrantRevision: 1,
      mode: "full_access", actionId: "explicit-test-grant",
      operations: [{ toolName: "archive_fixture", operationId: "read", contractVersion: 1 }],
    });
    const published = await f.studio.publish(f.draft.automationId, edited.revision);
    expect(published.definition.revision).toBe(2);
    expect(published.job.state).toBe("paused");
    await f.scheduler.stop();
    await f.scheduler.start();
    expect(await f.studio.getDraft(f.draft.automationId)).toEqual(edited);
    expect((await f.persistence.read()).definitions.map((item) => item.revision)).toEqual([1, 2]);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, "2", null])("rejects invalid storageRevision %s without committing", async (storageRevision) => {
    const f = await fixture();
    await expect(f.persistence.update((state) => {
      state.drafts[0] = { ...state.drafts[0]!, storageRevision } as typeof f.draft;
    })).rejects.toThrow("scheduler_store_corrupt");
    expect((await f.persistence.read()).drafts[0]).toEqual(f.draft);
  });

  it("validates archive timestamps while old draft records remain readable", async () => {
    const f = await fixture();
    expect(parseAutomationStoredRecord("drafts", f.draft)).toEqual(f.draft);
    expect(() => parseAutomationStoredRecord("drafts", { ...f.draft, archivedAt: "invalid" }))
      .toThrow("scheduler_store_corrupt");
  });

  it("rejects stale revisions and unpublished drafts without changing journal state", async () => {
    const f = await fixture();
    const unpublished = await f.studio.create("Still a draft");
    const before = await f.persistence.read();
    await expect(f.studio.archive(f.draft.automationId, f.draft.revision + 1))
      .rejects.toThrow("automation_revision_conflict");
    await expect(f.studio.archive(unpublished.automationId, unpublished.revision))
      .rejects.toThrow("automation_not_published");
    expect(await f.persistence.read()).toEqual(before);
  });

  it.each(["pending", "running", "stopping"] as const)(
    "refuses archive while a %s run owns admission", async (status) => {
      const f = await fixture();
      await f.seedRun(status);
      const before = await f.store.read();
      await expect(f.studio.archive(f.draft.automationId, f.draft.revision))
        .rejects.toThrow("automation_run_active");
      expect((await f.persistence.read()).drafts[0]).not.toHaveProperty("archivedAt");
      expect(await f.store.read()).toEqual(before);
    },
  );

  it("rejects archived edits, publication, activation, manual runs and replay through canonical owners", async () => {
    const f = await fixture();
    const previous = await f.seedRun("succeeded");
    await f.studio.archive(f.draft.automationId, f.draft.revision);
    await expect(f.studio.updateDraft(f.draft.automationId, f.draft.revision, {
      kind: "update_definition", patch: { title: "Stale editor" },
    })).rejects.toThrow("automation_archived");
    await expect(f.studio.publish(f.draft.automationId, f.draft.revision))
      .rejects.toThrow("automation_archived");
    await expect(f.studio.activate(f.draft.automationId)).rejects.toThrow("automation_archived");
    await expect(f.studio.runNow(f.draft.automationId, "existing-key"))
      .rejects.toThrow("automation_archived");
    await expect(f.studio.rerun(previous.id, "replay-key", true))
      .rejects.toThrow("automation_archived");
    const grant = await f.studio.getGrant(f.draft.automationId);
    await expect(f.studio.replaceGrant({
      automationId: f.draft.automationId, expectedGrantRevision: 1,
      mode: "full_plus", actionId: "stale-permission-editor", operations: [],
    })).rejects.toThrow("automation_archived");
    expect(await f.studio.getGrant(f.draft.automationId)).toEqual(grant);
    await expect(f.scheduler.updateAutomationJob(f.job.id, { title: "Bypass" }))
      .rejects.toThrow("automation_archived");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.prepareReplay).not.toHaveBeenCalled();
    expect((await f.persistence.read()).drafts[0]?.definition.title).toBe(f.draft.definition.title);
  });
});

describe("archive and scheduler admission races", () => {
  it.each(["ready", "no_input"] as const)(
    "rejects a manual %s preparation that finishes after archive", async (kind) => {
      const f = await fixture();
      const entered = deferred<void>();
      const finish = deferred<PreparedAutomationOccurrence>();
      const discard = vi.fn(async () => undefined);
      const commit = vi.fn();
      f.prepare.mockImplementationOnce(async () => { entered.resolve(); return finish.promise; });
      const starting = f.studio.runNow(f.draft.automationId);
      const rejected = expect(starting).rejects.toThrow("automation_archived");
      await entered.promise;
      await f.studio.archive(f.draft.automationId, f.draft.revision);
      const prepared = f.ready(f.job);
      finish.resolve(kind === "ready" ? { ...prepared, kind: "ready", inputIds: [], discard } :
        { kind: "no_input", commit });
      await rejected;
      expect(commit).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledTimes(kind === "ready" ? 1 : 0);
      expect((await f.store.read()).runs).toEqual([]);
      expect((await f.persistence.read()).executions).toEqual([]);
      expect(f.start).not.toHaveBeenCalled();
    },
  );

  it("discards a prepared scheduled occurrence after archive wins the journal transaction", async () => {
    const f = await fixture();
    await f.studio.activate(f.draft.automationId);
    f.advance();
    const entered = deferred<void>();
    const finish = deferred<PreparedAutomationOccurrence>();
    const discard = vi.fn(async () => undefined);
    f.prepare.mockImplementationOnce(async () => { entered.resolve(); return finish.promise; });
    const ticking = f.scheduler.tick();
    await entered.promise;
    await f.studio.archive(f.draft.automationId, f.draft.revision);
    finish.resolve({ ...f.ready(f.job), kind: "ready", inputIds: [], discard });
    await ticking;
    expect(discard).toHaveBeenCalledOnce();
    expect((await f.store.read()).runs).toEqual([]);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("rejects replay admission when archive completes during replay preparation", async () => {
    const f = await fixture();
    const previous = await f.seedRun("succeeded");
    const entered = deferred<void>();
    type Replay = Awaited<ReturnType<NonNullable<SchedulerAutomationExecutor["prepareReplay"]>>>;
    const finish = deferred<Replay>();
    const discard = vi.fn(async () => undefined);
    f.prepareReplay.mockImplementationOnce(async () => { entered.resolve(); return finish.promise; });
    const replay = f.scheduler.rerunAutomationRun(previous.id, {
      confirmed: true, idempotencyKey: "replay-key", validateAdmission: vi.fn(),
    });
    const rejected = expect(replay).rejects.toThrow("automation_archived");
    await entered.promise;
    await f.studio.archive(f.draft.automationId, f.draft.revision);
    const prepared = f.ready(f.job);
    if (prepared.kind !== "ready") throw new Error("fixture_not_ready");
    finish.resolve({ ...prepared, discard });
    await rejected;
    expect(discard).toHaveBeenCalledOnce();
    expect((await f.store.read()).runs).toHaveLength(1);
    expect((await f.persistence.read()).executions).toHaveLength(1);
  });

  it("refuses archive when manual admission has already committed", async () => {
    const f = await fixture();
    const admitted = await f.studio.runNow(f.draft.automationId);
    expect(admitted.status).toBe("pending");
    await expect(f.studio.archive(f.draft.automationId, f.draft.revision))
      .rejects.toThrow("automation_run_active");
    expect((await f.store.read()).runs).toHaveLength(1);
  });
});
