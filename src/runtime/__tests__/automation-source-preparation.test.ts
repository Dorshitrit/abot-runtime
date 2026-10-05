import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createFileAttachmentStore } from "../attachments/store.js";
import type { RuntimeConfig, RuntimePaths } from "../ports.js";
import type { SchedulerAutomationJob, SchedulerAutomationRun } from "../scheduler/contracts.js";
import type { AutomationRevision, FolderSource } from "../automations/definition-contracts.js";
import {
  holdInterruptedInputs,
  releaseNeverDispatchedInputs,
} from "../automations/input-ledger.js";
import { createAutomationOccurrencePreparer } from "../automations/occurrence-preparation.js";
import { createAutomationReplayPreparer } from "../automations/replay-preparation.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState, parseAutomationJournalState } from "../automations/storage-records.js";
import { captureSourceFile, discoverSourceFiles } from "../automations/source-discovery.js";
import { resolveAutomationSourceManifest } from "../automations/step-runner.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(sourceOptions: Partial<FolderSource> = {}) {
  const root = await mkdtemp(join(tmpdir(), "automation-source-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "inbox");
  const paths: RuntimePaths = {
    rootDir: root,
    runtimeDir: join(root, "runtime"),
    agentWorkDir: join(root, "work"),
    sessionsDir: join(root, "sessions"),
    attachmentsDir: join(root, "attachments"),
    workspaceDir: join(root, "workspace"),
    sharedDir: join(root, "shared"),
    compiledDir: join(root, "compiled"),
    traceFile: join(root, "trace.jsonl"),
  };
  await mkdir(folder);
  const source: FolderSource = {
    sourceId: "source-1",
    location: { kind: "runtime_path", path: folder },
    includePatterns: ["**/*.txt"],
    excludePatterns: ["archive/**"],
    recursive: true,
    includeExisting: false,
    mode: "per_file",
    maxBatchFiles: 10,
    ...sourceOptions,
  };
  const definition: AutomationRevision = {
    schemaVersion: 1,
    automationId: "automation-1",
    revision: 1,
    title: "Read inbox",
    objective: "Process new text files",
    trigger: { kind: "folder", checkEveryMs: 60_000, minimumEligibleFiles: 1 },
    source,
    inputs: {},
    body: { kind: "sequence", id: "root", children: [] },
    limits: {
      maxConcurrentNodes: 2,
      maxModelCallsPerRun: 24,
      maxToolCallsPerRun: 64,
      maxRunDurationMs: 30 * 60_000,
      maxRunsPerDay: 24,
      maxStoredArtifactBytes: 256 * 1024 * 1024,
      stopReportDeadlineMs: 30_000,
    },
  };
  const job: SchedulerAutomationJob = {
    id: "job-1",
    environmentId: "dev",
    target: { kind: "automation", automationId: "automation-1", definitionRevision: 1 },
    title: definition.title,
    timeZone: "UTC",
    schedule: { kind: "interval", everyMs: 60_000, anchorAt: "2026-09-29T10:00:00Z" },
    state: "active",
    createdAt: "2026-09-29T09:00:00Z",
    updatedAt: "2026-09-29T09:00:00Z",
    nextRunAt: "2026-09-29T10:00:00Z",
    revision: 1,
  };
  const state = emptyAutomationJournalState();
  state.definitions.push({
    id: "definition-1", automationId: "automation-1", revision: 1,
    definition, publishedAt: "2026-09-29T09:00:00Z",
  });
  const persistence = {
    read: async () => structuredClone(state),
  } as AutomationPersistence;
  const attachments = createFileAttachmentStore({ attachmentsDir: paths.attachmentsDir });
  const config = { runtimeId: "dev", paths } as RuntimeConfig;
  const prepare = createAutomationOccurrencePreparer({
    config, persistence, attachments, now: () => Date.parse("2026-09-29T10:00:00Z"),
  });
  async function file(name: string, content: string) {
    const path = join(folder, name);
    await writeFile(path, content);
    const old = new Date("2026-09-29T09:00:00Z");
    await utimes(path, old, old);
    return path;
  }
  return { root, folder, paths, state, job, source, prepare, persistence, attachments, file };
}

test("first scan excludes existing versions, records an empty-safe baseline, then claims a new version", async () => {
  const f = await fixture();
  await f.file("old.txt", "already here");
  const first = await f.prepare(f.job, "run-baseline", "schedule");
  expect(first.kind).toBe("no_input");
  if (first.kind !== "no_input") return;
  first.commit?.(f.state);
  expect(f.state.inputs).toHaveLength(2);
  expect(f.state.inputs.every((record) => record.eligibility === "baseline")).toBe(true);
  await f.file("new.txt", "new content");
  const second = await f.prepare(f.job, "run-new", "schedule");
  expect(second.kind).toBe("ready");
  if (second.kind !== "ready") return;
  second.commit(f.state, "run-new");
  expect(second.inputIds).toHaveLength(1);
  const claimed = f.state.inputs.find((record) => record.id === second.inputIds[0]);
  expect(claimed).toMatchObject({ eligibility: "eligible", claimRunId: "run-new" });
  expect(claimed?.snapshot).toBeDefined();
  const resolved = await f.attachments.resolveAttachment(claimed!.snapshot!.attachment);
  expect(await readFile(resolved.absolutePath, "utf8")).toBe("new content");
  const duplicate = await f.prepare(f.job, "run-repeat", "schedule");
  expect(duplicate.kind).toBe("no_input");
});

test("a restarted preparer reconciles snapshots left before the durable input claim", async () => {
  const f = await fixture({ includeExisting: true });
  const sourcePath = await f.file("new.txt", "original survives restart");
  const abandoned = await f.prepare(f.job, "crashed-candidate", "schedule");
  expect(abandoned.kind).toBe("ready");
  const orphanDirectory = join(f.paths.attachmentsDir, "crashed-candidate");
  expect((await stat(orphanDirectory)).isDirectory()).toBe(true);
  // Recreate only the preparer: the previous process never committed or discarded its result.
  const restarted = createAutomationOccurrencePreparer({
    config: { runtimeId: "dev", paths: f.paths } as RuntimeConfig,
    persistence: f.persistence, attachments: f.attachments,
    now: () => Date.parse("2026-09-29T10:00:00Z"),
  });
  const prepared = await restarted(f.job, "new-candidate", "schedule");
  expect(prepared.kind).toBe("ready");
  await expect(stat(orphanDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(sourcePath, "utf8")).toBe("original survives restart");
  if (prepared.kind !== "ready") throw new Error("ready preparation required");
  prepared.commit(f.state, "new-candidate");
  const committed = f.state.inputs.find((input) => input.claimRunId === "new-candidate")!;
  const retained = await f.attachments.resolveAttachment(committed.snapshot!.attachment);
  expect(await readFile(retained.absolutePath, "utf8")).toBe("original survives restart");
  const again = await restarted(f.job, "another-candidate", "schedule");
  expect(again.kind).toBe("no_input");
  expect(await readFile(retained.absolutePath, "utf8")).toBe("original survives restart");
});

test("a republished folder with the same source id establishes its own baseline", async () => {
  const f = await fixture();
  await f.file("old.txt", "original folder");
  const initial = await f.prepare(f.job, "original-baseline", "schedule");
  expect(initial.kind).toBe("no_input");
  if (initial.kind !== "no_input") return;
  initial.commit?.(f.state);

  const replacement = join(f.root, "replacement");
  await mkdir(replacement);
  const existingFile = join(replacement, "existing.txt");
  await writeFile(existingFile, "already in the replacement folder");
  const stableAt = new Date("2026-09-29T09:00:00Z");
  await utimes(existingFile, stableAt, stableAt);
  const previous = f.state.definitions[0]!;
  f.state.definitions.push({
    ...previous, id: "definition-2", revision: 2,
    definition: {
      ...previous.definition, revision: 2,
      source: { ...f.source, location: { kind: "runtime_path", path: replacement } },
    },
  });
  const republished = { ...f.job, target: { ...f.job.target, definitionRevision: 2 } };
  const first = await f.prepare(republished, "replacement-baseline", "schedule");
  expect(first.kind).toBe("no_input");
  if (first.kind !== "no_input") return;
  first.commit?.(f.state);
  expect(f.state.inputs.filter((record) => record.baselineMarker)
    .map((record) => record.canonicalPath)).toEqual([f.folder, replacement]);
  expect(f.state.inputs.find((record) => record.canonicalPath === existingFile))
    .toMatchObject({ eligibility: "baseline", sourceId: f.source.sourceId });

  const newFile = join(replacement, "new.txt");
  await writeFile(newFile, "arrived after activation");
  await utimes(newFile, stableAt, stableAt);
  const next = await f.prepare(republished, "replacement-new", "schedule");
  expect(next.kind).toBe("ready");
  if (next.kind !== "ready") return;
  next.commit(f.state, "replacement-new");
  expect(next.inputIds).toHaveLength(1);
  expect(f.state.inputs.find((record) => record.id === next.inputIds[0]))
    .toMatchObject({ canonicalPath: newFile, claimRunId: "replacement-new" });
});

test("a 1000-file first scan baselines every file and later admits a changed version", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 1_000 }, (_, index) =>
    f.file(`existing-${index}.txt`, `existing ${index}`)));
  const first = await f.prepare(f.job, "full-baseline", "schedule");
  expect(first.kind).toBe("no_input");
  if (first.kind !== "no_input") return;
  first.commit?.(f.state);
  expect(f.state.inputs).toHaveLength(1_001);
  expect(f.state.inputs.every((record) => record.eligibility === "baseline")).toBe(true);
  await f.file("existing-0.txt", "changed after first activation");
  const next = await f.prepare(f.job, "changed-version", "schedule");
  expect(next.kind).toBe("ready");
  if (next.kind !== "ready") return;
  next.commit(f.state, "changed-version");
  expect(next.inputIds).toHaveLength(1);
  expect(f.state.inputs.find((record) => record.id === next.inputIds[0]))
    .toMatchObject({ canonicalPath: join(f.folder, "existing-0.txt"), claimRunId: "changed-version" });
});

test("a source path alias reuses the same canonical folder baseline", async () => {
  const f = await fixture();
  const initial = await f.prepare(f.job, "empty-baseline", "schedule");
  expect(initial.kind).toBe("no_input");
  if (initial.kind !== "no_input") return;
  initial.commit?.(f.state);
  await f.file("new.txt", "new content");
  const alias = join(f.root, "inbox-alias");
  await symlink(f.folder, alias);
  const previous = f.state.definitions[0]!;
  f.state.definitions[0] = {
    ...previous,
    definition: {
      ...previous.definition,
      source: { ...f.source, location: { kind: "runtime_path", path: alias } },
    },
  };
  const next = await f.prepare(f.job, "alias-new", "schedule");
  expect(next.kind).toBe("ready");
  if (next.kind !== "ready") return;
  next.commit(f.state, "alias-new");
  expect(f.state.inputs.filter((record) => record.baselineMarker)).toHaveLength(1);
  expect(next.inputIds).toHaveLength(1);
});

test("a new overlapping root excludes released pending versions without discarding replay inputs", async () => {
  const f = await fixture({ includeExisting: true });
  const nested = join(f.folder, "nested");
  await mkdir(nested);
  await f.file("nested/pending.txt", "pending version");
  const pending = await f.prepare(f.job, "old-pending", "schedule");
  expect(pending.kind).toBe("ready");
  if (pending.kind !== "ready") return;
  pending.commit(f.state, "old-pending");
  releaseNeverDispatchedInputs(f.state, "old-pending");
  const retained = structuredClone(f.state.inputs.find((record) => record.id === pending.inputIds[0]));
  const original = f.state.definitions[0]!;
  f.state.definitions.push({ ...original, id: "definition-2", revision: 2,
    definition: { ...original.definition, revision: 2,
      source: { ...f.source, includeExisting: false, location: { kind: "runtime_path", path: nested } } },
  });
  const republished = { ...f.job, target: { ...f.job.target, definitionRevision: 2 } };
  const baseline = await f.prepare(republished, "nested-baseline", "schedule");
  expect(baseline.kind).toBe("no_input");
  if (baseline.kind !== "no_input") return;
  baseline.commit?.(f.state);
  Object.assign(f.state, parseAutomationJournalState(JSON.parse(JSON.stringify(f.state))));
  expect(f.state.inputs.find((record) => record.id === retained?.id)).toEqual(retained);
  expect((await f.prepare(republished, "nested-repeat", "schedule")).kind).toBe("no_input");
  const originalRoot = await f.prepare(f.job, "original-root-reuse", "schedule");
  expect(originalRoot.kind).toBe("ready");
  if (originalRoot.kind === "ready") expect(originalRoot.inputIds).toEqual(pending.inputIds);
  await f.file("nested/pending.txt", "new version after the nested baseline");
  const changed = await f.prepare(republished, "nested-changed", "schedule");
  expect(changed.kind).toBe("ready");
  if (changed.kind !== "ready") return;
  changed.commit(f.state, "nested-changed");
  expect(changed.inputIds).toHaveLength(1);
  expect(changed.inputIds).not.toEqual(pending.inputIds);
});

test("batch selection is bounded and pending claims release while interrupted claims hold", async () => {
  const f = await fixture({ includeExisting: true, mode: "batch", maxBatchFiles: 2 });
  await f.file("a.txt", "A");
  await f.file("b.txt", "B");
  await f.file("c.txt", "C");
  const first = await f.prepare(f.job, "run-batch", "schedule");
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") return;
  expect(first.inputIds).toHaveLength(2);
  first.commit(f.state, "run-batch");
  holdInterruptedInputs(f.state, "run-batch");
  expect(f.state.inputs.filter((record) => record.eligibility === "held")).toHaveLength(2);
  const next = await f.prepare(f.job, "run-next", "schedule");
  expect(next.kind).toBe("ready");
  if (next.kind !== "ready") return;
  expect(next.inputIds).toHaveLength(1);
  next.commit(f.state, "run-next");
  releaseNeverDispatchedInputs(f.state, "run-next");
  const released = f.state.inputs.find((record) => record.id === next.inputIds[0]);
  expect(released?.eligibility).toBe("eligible");
  expect(released?.claimRunId).toBeUndefined();
  const replay = await f.prepare(f.job, "run-reclaimed", "schedule");
  expect(replay.kind).toBe("ready");
  if (replay.kind === "ready") expect(replay.inputIds).toEqual(next.inputIds);
});

test("discovery excludes archive paths and does not follow symlink escapes", async () => {
  const f = await fixture({ includeExisting: true });
  await mkdir(join(f.folder, "archive"));
  await f.file("kept.txt", "keep");
  await writeFile(join(f.folder, "archive", "old.txt"), "archive");
  const outside = join(f.root, "outside.txt");
  await writeFile(outside, "outside");
  await symlink(outside, join(f.folder, "link.txt"));
  const discovered = await discoverSourceFiles({
    source: f.source, paths: f.paths, now: Date.parse("2026-09-29T10:00:00Z"),
  });
  expect(discovered.files.map((file) => file.relativePath)).toEqual(["kept.txt"]);
});

test("capture rejects a path replaced by a symlink after discovery", async () => {
  const f = await fixture({ includeExisting: true });
  const inputPath = await f.file("original.txt", "original");
  const outside = join(f.root, "outside.txt");
  await writeFile(outside, "outsider");
  const discovered = await discoverSourceFiles({
    source: f.source, paths: f.paths, now: Date.parse("2026-09-29T10:00:00Z"),
  });
  await rm(inputPath);
  await symlink(outside, inputPath);
  await expect(captureSourceFile(discovered.files[0]!))
    .rejects.toThrow("automation_source_changed");
});

test("replay reuses a retained immutable snapshot without changing historical input claims", async () => {
  const f = await fixture({ includeExisting: true });
  await f.file("receipt.txt", "receipt");
  const original = await f.prepare(f.job, "run-original", "manual");
  expect(original.kind).toBe("ready");
  if (original.kind !== "ready") return;
  original.commit(f.state, "run-original");
  const inputBefore = structuredClone(f.state.inputs[0]);
  const previous: SchedulerAutomationRun = {
    id: "run-original", jobId: f.job.id, environmentId: "dev",
    target: f.job.target, title: f.job.title, timeZone: f.job.timeZone,
    jobRevision: 1, scheduledAt: "2026-09-29T10:00:00Z",
    trigger: "manual", status: "failed", reportRef: "derived:run-original",
  };
  const prepareReplay = createAutomationReplayPreparer({
    persistence: f.persistence, attachments: f.attachments,
  });
  const replay = await prepareReplay(f.job, previous, "run-replay");
  expect(replay.kind).toBe("ready");
  if (replay.kind !== "ready") return;
  replay.commit(f.state, "run-replay");
  expect(replay.inputIds).toEqual(original.inputIds);
  expect(f.state.inputs[0]).toEqual(inputBefore);
  expect(f.state.executions.find((item) => item.id === "run-replay"))
    .toMatchObject({ inputIds: original.inputIds, definitionRevision: 1 });
});

test("batch handoff exposes all 100 exact frozen inputs and rejects changed or foreign snapshots", async () => {
  const f = await fixture({ includeExisting: true, mode: "batch", maxBatchFiles: 100 });
  for (let index = 0; index < 100; index += 1)
    await f.file(`receipt-${String(index).padStart(3, "0")}.txt`, `receipt ${index}`);
  const prepared = await f.prepare(f.job, "run-batch-100", "manual");
  expect(prepared.kind).toBe("ready");
  if (prepared.kind !== "ready") return;
  prepared.commit(f.state, "run-batch-100");
  const definition = f.state.definitions[0]!.definition;
  const manifest = await resolveAutomationSourceManifest({
    inputIds: prepared.inputIds, state: f.state, definition, attachments: f.attachments,
  });
  expect(manifest.files).toHaveLength(100);
  expect(manifest.attachments.map((item) => item.id)).toEqual(prepared.inputIds);
  expect(manifest.attachments.every((item) => item.absolutePath.startsWith(f.paths.attachmentsDir)))
    .toBe(true);

  await writeFile(join(f.folder, "receipt-000.txt"), "changed source after capture");
  const frozen = await readFile(manifest.attachments[0]!.absolutePath, "utf8");
  expect(frozen).toBe("receipt 0");
  await expect(resolveAutomationSourceManifest({
    inputIds: ["unknown-input"], state: f.state, definition, attachments: f.attachments,
  })).rejects.toThrow("automation_source_unavailable");
  const foreign = structuredClone(f.state);
  foreign.inputs[0] = { ...foreign.inputs[0]!, automationId: "other-automation" };
  await expect(resolveAutomationSourceManifest({
    inputIds: prepared.inputIds, state: foreign, definition, attachments: f.attachments,
  })).rejects.toThrow("automation_source_unavailable");
  await writeFile(manifest.attachments[0]!.absolutePath, "changed snapshot");
  await expect(resolveAutomationSourceManifest({
    inputIds: prepared.inputIds, state: f.state, definition, attachments: f.attachments,
  })).rejects.toThrow("automation_source_changed");
});
