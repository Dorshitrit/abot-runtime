import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type { AutomationTrigger } from "../automations/definition-contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { createAutomationPersistence } from "../automations/persistence.js";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import { createAutomationGrantManager } from "../automations/permission-grants.js";
import { createAutomationPublicationService } from "../automations/publication.js";
import { createAutomationService } from "../automations/service.js";
import { createAutomationResultStore } from "../automations/result-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const acceptedAt = Date.parse("2026-09-30T08:00:00.000Z");
async function fixture(trigger: AutomationTrigger, initialTime = acceptedAt) {
  const root = await mkdtemp(join(tmpdir(), "automation-publication-cadence-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let now = initialTime;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const store = createFileSchedulerStore(root);
  const scheduler = createSchedulerService({ environmentId: "dev", store,
    now: () => now, tickIntervalMs: 1_000_000,
    executor: { sessionExists: async () => true, tryReserve: () => null, start: vi.fn() },
  });
  cleanups.push(() => scheduler.stop());
  await scheduler.start();
  const persistence = createAutomationPersistence(store);
  const drafts = createAutomationDraftManager({ persistence });
  const operation = { toolName: "fixture", operationId: "read", contractVersion: 1 };
  const tools = { listNormalInvocations: () => [{ toolName: "fixture", definition: {},
    contract: { version: 1, operations: [{ operationId: "read", summary: "Read",
      effect: "read_only", approval: "request_policy",
      input: { type: "object", properties: {}, required: [], additionalProperties: false } }] },
  }] } as unknown as ToolRegistry;
  const grants = createAutomationGrantManager({ persistence, environmentId: "dev",
    availableOperations: async () => [{ operation, requiredMode: "full_access" }] });
  const config = { runtimeId: "dev" } as RuntimeConfig;
  const publicationIn = (timeZone = "UTC") => createAutomationPublicationService({
    config, drafts, grants, persistence, scheduler, tools, timeZone, now: () => now });
  const studio = createAutomationService({ config, scheduler, persistence, tools,
    results: createAutomationResultStore(root), timeZone: "UTC" });
  let draft = await drafts.create("Scheduled workflow");
  draft = await drafts.update(draft.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
    nodeWithoutId: { kind: "tool", title: "Read", onFailure: "stop", operation, controls: {} },
  });
  draft = await drafts.update(draft.automationId, draft.revision, { kind: "update_definition", patch: {
    trigger, ...(trigger.kind === "folder" ? { source: { sourceId: "source",
      location: { kind: "runtime_path", path: root }, includePatterns: ["*.txt"],
      excludePatterns: [], recursive: false, includeExisting: false, mode: "per_file", maxBatchFiles: 1 } } : {}),
  } });
  await grants.replace({ automationId: draft.automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [operation], actionId: "grant" });
  const publication = publicationIn();
  const first = await publication.publish(draft.automationId, draft.revision);
  const edit = async (patch: Record<string, unknown>) => {
    draft = await drafts.update(draft.automationId, draft.revision, { kind: "update_definition", patch });
    return draft;
  };
  return { store, scheduler, persistence, drafts, publication, publicationIn, studio, first, edit,
    draft: () => draft, advance: (milliseconds: number) => { now += milliseconds; } };
}

test.each(["paused", "active", "completed"] as const)("republishing unchanged timer preserves %s timing and state", async (state) => {
  const f = await fixture({ kind: "schedule", schedule: { kind: "timer", delayMs: 60_000 } });
  await f.store.update((scheduler) => {
    scheduler.jobs[0]!.state = state;
    if (state === "completed") scheduler.jobs[0]!.nextRunAt = null;
  });
  const previous = await f.scheduler.getAutomationJob(f.draft().automationId);
  f.advance(state === "completed" ? 120_000 : 20_000);
  await f.edit({ title: "Renamed" });
  expect(await f.studio.validate(f.draft().automationId)).toEqual([]);
  const next = await f.publication.publish(f.draft().automationId, f.draft().revision);
  expect(next.job).toMatchObject({ state, schedule: previous!.schedule, nextRunAt: previous!.nextRunAt });
  expect(next.definition.revision).toBe(f.draft().revision);
  expect((await f.store.read()).runs).toEqual([]);
});

test.each([
  { kind: "schedule", schedule: { kind: "interval", everyMs: 60_000 } },
  { kind: "folder", checkEveryMs: 60_000, minimumEligibleFiles: 1 },
] satisfies AutomationTrigger[])("unchanged $kind cadence survives graph republish", async (trigger) => {
  const f = await fixture(trigger);
  f.advance(25_000);
  const draft = f.draft();
  const edited = await f.drafts.update(draft.automationId, draft.revision, {
    kind: "update_node", nodeId: draft.definition.body.children[0]!.id, patch: { title: "Updated step" },
  });
  const next = await f.publication.publish(edited.automationId, edited.revision);
  expect(next.job.schedule).toEqual(f.first.job.schedule);
  expect(next.job.nextRunAt).toBe(f.first.job.nextRunAt);
  expect(next.job.state).toBe("paused");
});

test("an actual timer delay edit re-arms a completed timer from the acceptance clock", async () => {
  const f = await fixture({ kind: "schedule", schedule: { kind: "timer", delayMs: 60_000 } });
  await f.store.update((scheduler) => { scheduler.jobs[0]!.state = "completed"; scheduler.jobs[0]!.nextRunAt = null; });
  f.advance(120_000);
  await f.edit({ trigger: { kind: "schedule", schedule: { kind: "timer", delayMs: 90_000 } } });
  const next = await f.publication.publish(f.draft().automationId, f.draft().revision);
  expect(next.job).toMatchObject({ state: "active", nextRunAt: "2026-09-30T08:03:30.000Z",
    schedule: { kind: "timer", delayMs: 90_000, at: "2026-09-30T08:03:30.000Z" } });
});

test.each([
  { kind: "interval", everyMs: 90_000 },
  { kind: "interval", everyMs: 60_000, anchorAt: "2026-09-30T08:04:00.000Z" },
] as const)("an actual interval edit uses its new timing", async (schedule) => {
  const f = await fixture({ kind: "schedule", schedule: { kind: "interval", everyMs: 60_000 } });
  f.advance(20_000);
  await f.edit({ trigger: { kind: "schedule", schedule } });
  const next = await f.publication.publish(f.draft().automationId, f.draft().revision);
  const expected = "anchorAt" in schedule ? schedule.anchorAt : "2026-09-30T08:01:50.000Z";
  expect(next.job.schedule).toEqual({ ...schedule, anchorAt: expected });
  expect(next.job.nextRunAt).toBe(expected);
});

test("removing an authored explicit interval anchor is an actual edit", async () => {
  const f = await fixture({ kind: "schedule", schedule: { kind: "interval", everyMs: 60_000,
    anchorAt: "2026-09-30T08:04:00.000Z" } });
  f.advance(20_000);
  await f.edit({ trigger: { kind: "schedule", schedule: { kind: "interval", everyMs: 60_000 } } });
  const next = await f.publication.publish(f.draft().automationId, f.draft().revision);
  expect(next.job.nextRunAt).toBe("2026-09-30T08:01:20.000Z");
});

test("changing timezone metadata does not re-arm a completed relative timer", async () => {
  const f = await fixture({ kind: "schedule", schedule: { kind: "timer", delayMs: 60_000 } });
  await f.store.update((scheduler) => { scheduler.jobs[0]!.state = "completed"; scheduler.jobs[0]!.nextRunAt = null; });
  f.advance(120_000);
  await f.edit({ title: "New zone" });
  const next = await f.publicationIn("Asia/Jerusalem").publish(f.draft().automationId, f.draft().revision);
  expect(next.job).toMatchObject({ state: "completed", nextRunAt: null, timeZone: "Asia/Jerusalem",
    schedule: f.first.job.schedule });
});

test("the direct scheduler API retains explicit relative reschedule behavior", async () => {
  const f = await fixture({ kind: "schedule", schedule: { kind: "timer", delayMs: 60_000 } });
  f.advance(20_000);
  const next = await f.scheduler.updateAutomationJob(f.first.job.id, { schedule: { kind: "timer", delayMs: 60_000 } });
  expect(next.nextRunAt).toBe("2026-09-30T08:01:20.000Z");
});

test.each([false, true])("changing between folder and schedule starts the newly authored cadence: reverse=%s", async (reverse) => {
  const f = await fixture({ kind: "folder", checkEveryMs: 60_000, minimumEligibleFiles: 1 });
  f.advance(20_000);
  await f.edit({ trigger: { kind: "schedule", schedule: { kind: "interval", everyMs: 60_000 } } });
  const scheduled = await f.publication.publish(f.draft().automationId, f.draft().revision);
  expect(scheduled.job.nextRunAt).toBe("2026-09-30T08:01:20.000Z");
  if (!reverse) return;
  f.advance(20_000);
  await f.edit({ trigger: { kind: "folder", checkEveryMs: 60_000, minimumEligibleFiles: 1 } });
  const folder = await f.publication.publish(f.draft().automationId, f.draft().revision);
  expect(folder.job.nextRunAt).toBe("2026-09-30T08:01:40.000Z");
});

test.each([
  { kind: "timer", delayMs: 1_000 },
  { kind: "interval", everyMs: 1_000 },
] as const)("unchanged $kind readiness does not normalize a new out-of-range relative deadline", async (schedule) => {
  const f = await fixture({ kind: "schedule", schedule }, Date.parse("9999-12-31T23:59:56.000Z"));
  f.advance(3_999);
  await f.edit({ title: "Metadata only" });
  expect(await f.studio.validate(f.draft().automationId)).toEqual([]);
  const next = await f.publication.publish(f.draft().automationId, f.draft().revision);
  expect(next.job.schedule).toEqual(f.first.job.schedule);
  expect(next.job.nextRunAt).toBe(f.first.job.nextRunAt);
  const changed = schedule.kind === "timer"
    ? { kind: "timer", delayMs: 2_000 } : { kind: "interval", everyMs: 2_000 };
  await f.edit({ trigger: { kind: "schedule", schedule: changed } });
  expect(await f.studio.validate(f.draft().automationId)).toEqual([
    expect.objectContaining({ code: "scheduler_invalid_schedule" }),
  ]);
  await expect(f.publication.publish(f.draft().automationId, f.draft().revision))
    .rejects.toThrow("automation_graph_invalid");
  expect(await f.scheduler.getAutomationJob(f.draft().automationId)).toEqual(next.job);
});

test("a concurrent scheduler timing edit rejects the stale publication atomically", async () => {
  const f = await fixture({ kind: "schedule", schedule: { kind: "timer", delayMs: 60_000 } });
  f.advance(20_000);
  await f.edit({ title: "Republish" });
  const definitions = (await f.persistence.read()).definitions;
  const get = f.scheduler.getAutomationJob.bind(f.scheduler);
  vi.spyOn(f.scheduler, "getAutomationJob").mockImplementationOnce(async (id) => {
    const observed = await get(id);
    await f.scheduler.updateAutomationJob(f.first.job.id, { schedule: { kind: "timer", delayMs: 90_000 } });
    return observed;
  });
  await expect(f.publication.publish(f.draft().automationId, f.draft().revision))
    .rejects.toThrow("automation_revision_conflict");
  expect((await f.persistence.read()).definitions).toEqual(definitions);
  expect(await get(f.draft().automationId)).toMatchObject({ title: "Scheduled workflow",
    target: f.first.job.target, schedule: { kind: "timer", delayMs: 90_000, at: "2026-09-30T08:01:50.000Z" } });
});

test("publishing an already published revision preserves its existing error and changes no timing", async () => {
  const f = await fixture({ kind: "schedule", schedule: { kind: "timer", delayMs: 60_000 } });
  f.advance(20_000);
  await expect(f.publication.publish(f.draft().automationId, f.draft().revision))
    .rejects.toThrow("automation_already_published");
  expect(await f.scheduler.getAutomationJob(f.draft().automationId)).toEqual(f.first.job);
  expect((await f.persistence.read()).definitions).toEqual([f.first.definition]);
});
