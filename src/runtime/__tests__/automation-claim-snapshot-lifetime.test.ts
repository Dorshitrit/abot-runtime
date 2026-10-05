import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { RuntimeAttachmentReference } from "../../shared/attachments.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import { createAutomationSnapshotStaging } from "../automations/snapshot-staging.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { requestAutomationSchedulerRunNow } from "../scheduler/automation-job-management.js";
import { requestAutomationSchedulerRerun } from "../scheduler/automation-rerun.js";
import { enqueueDueAutomationOccurrences } from "../scheduler/automation-scheduler-engine.js";
import type { PreparedAutomationOccurrence, SchedulerAutomationExecutor,
  SchedulerAutomationJob, SchedulerAutomationRun, SchedulerSnapshot, SchedulerStore } from "../scheduler/contracts.js";
import type { SchedulerContext } from "../scheduler/service-context.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
type Failure = "before_publication" | "after_publication" | "uncertain_publication" | "stale_claim";

async function fixture(failure: Failure) {
  const root = await mkdtemp(join(tmpdir(), "automation-claim-snapshots-"));
  roots.push(root);
  let automations = emptyAutomationJournalState();
  let unreadable = false;
  const error = new Error(`claim_${failure}`);
  const readAutomations = async () => {
    if (unreadable) throw error;
    return structuredClone(automations);
  };
  const attachments = createFileAttachmentStore({ attachmentsDir: join(root, "attachments") });
  const snapshots = createAutomationSnapshotStaging({ runtimeDir: root, attachments,
    persistence: { read: readAutomations } as AutomationPersistence });
  const now = Date.parse("2026-09-30T08:00:00.000Z");
  const timestamp = new Date(now).toISOString();
  const job: SchedulerAutomationJob = { id: "job", environmentId: "test",
    target: { kind: "automation", automationId: "automation", definitionRevision: 1 },
    title: "Input", timeZone: "UTC", state: "active", revision: 1,
    schedule: { kind: "interval", everyMs: 60000, anchorAt: timestamp },
    createdAt: timestamp, updatedAt: timestamp, nextRunAt: timestamp };
  const previous: SchedulerAutomationRun = { id: "previous", jobId: job.id, environmentId: "test",
    target: job.target, title: job.title, timeZone: "UTC", jobRevision: 1,
    scheduledAt: timestamp, trigger: "manual", status: "failed", reportRef: "previous-report" };
  let scheduler: SchedulerSnapshot = { schemaVersion: 1, jobs: [job], runs: [previous] };
  let stagedRunId = "";
  let snapshot: RuntimeAttachmentReference | undefined;
  const discard = vi.fn(async () => snapshots.discard(stagedRunId));
  const prepare = async (_job: SchedulerAutomationJob, runId: string): Promise<PreparedAutomationOccurrence> => {
    stagedRunId = runId;
    await snapshots.begin(runId);
    snapshot = await attachments.saveAttachment({ sessionId: runId, requestId: "input", kind: "file",
      mimeType: "text/plain", bytes: new TextEncoder().encode("frozen source"), name: "source.txt" });
    return { kind: "ready", inputIds: [], discard, commit: (state, id) => {
      state.executions.push({ id, automationId: "automation", definitionRevision: 1,
        revision: 1, inputIds: [], nodes: [] });
    } };
  };
  const update: NonNullable<SchedulerStore["updateWithAutomations"]> = async (mutate) => {
    const nextScheduler = structuredClone(scheduler);
    const nextAutomations = structuredClone(automations);
    if (failure === "stale_claim") nextScheduler.jobs = [];
    const result = mutate(nextScheduler, nextAutomations);
    if (failure === "stale_claim") return result;
    if (failure === "before_publication") throw error;
    scheduler = nextScheduler;
    automations = nextAutomations;
    unreadable = failure === "uncertain_publication";
    throw error;
  };
  const context = { environmentId: "test", now: () => now, running: true,
    jobEpochs: new Map(), pendingJobMutations: new Set(),
    enqueue: async <T>(operation: () => Promise<T>) => operation(),
    store: { read: async () => structuredClone(scheduler), readAutomations,
      readRun: async () => previous, readAutomationRunByKey: async () => undefined,
      updateWithAutomations: update },
    automationExecutor: { prepare,
      prepareReplay: (candidate, _previous, runId) => prepare(candidate, runId),
    } satisfies Pick<SchedulerAutomationExecutor, "prepare" | "prepareReplay">,
  } as unknown as SchedulerContext;
  return { root, context, job, error, discard, snapshots, attachments,
    snapshot: () => snapshot!, runId: () => stagedRunId, restoreReads: () => { unreadable = false; } };
}

test("a scheduled occurrence that becomes stale still discards its unclaimed preparation", async () => {
  const f = await fixture("stale_claim");
  await enqueueDueAutomationOccurrences(f.context, f.context.now());
  expect(f.discard).toHaveBeenCalledOnce();
  await expect(f.attachments.resolveAttachment(f.snapshot())).rejects.toMatchObject({ code: "ENOENT" });
});

for (const path of ["manual", "scheduled", "replay"] as const) {
  test.each(["before_publication", "after_publication", "uncertain_publication"] as const)(
    `${path} claim %s releases staging without deleting committed bytes`, async (failure) => {
      const f = await fixture(failure);
      let claim: Promise<unknown>;
      if (path === "manual") claim = requestAutomationSchedulerRunNow(f.context, f.job.id);
      else if (path === "scheduled") claim = enqueueDueAutomationOccurrences(f.context, f.context.now());
      else claim = requestAutomationSchedulerRerun(f.context, "previous", {
        confirmed: true, idempotencyKey: "repeat", validateAdmission: () => undefined,
      });
      await expect(claim).rejects.toBe(f.error);
      expect(f.discard).toHaveBeenCalledOnce();
      f.restoreReads();
      await f.snapshots.reconcile();
      const marker = join(f.root, "automation-snapshot-preparations", `${f.runId()}.json`);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      if (failure === "before_publication") {
        await expect(f.attachments.resolveAttachment(f.snapshot())).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      expect((await f.attachments.resolveAttachment(f.snapshot())).metadata).toMatchObject(f.snapshot());
    },
  );
}
