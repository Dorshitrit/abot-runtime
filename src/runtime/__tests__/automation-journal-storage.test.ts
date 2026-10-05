import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SchedulerJob, SchedulerRun } from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { makeSchedulerRun } from "../scheduler/run-records.js";

const faults = vi.hoisted(() => ({
  syncPath: "",
  rejectManifestRename: false,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if (String(args[0]) === faults.syncPath)
          throw new Error("injected_directory_sync_failure");
        await sync();
      });
      return handle;
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (
        faults.rejectManifestRename &&
        String(args[1]).endsWith("scheduler-journal.json")
      )
        throw new Error("injected_manifest_rename_failure");
      return actual.rename(...args);
    }),
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  faults.syncPath = "";
  faults.rejectManifestRename = false;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), "automation-journal-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createFileSchedulerStore(directory);
  const release = await store.acquire();
  cleanups.push(release);
  const job: SchedulerJob = {
    id: "automation-job",
    environmentId: "test",
    sessionId: "automation-internal",
    title: "Automation",
    prompt: "Run the automation",
    modelProfileId: "model",
    agentMode: "fast",
    toolPermissionMode: "full_access",
    timeZone: "UTC",
    schedule: { kind: "daily", at: "09:00" },
    state: "active",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    nextRunAt: "2026-09-30T09:00:00.000Z",
    revision: 1,
  };
  const run: SchedulerRun = {
    ...makeSchedulerRun(job, "2026-09-29T09:00:00.000Z", "manual"),
    status: "pending",
  };
  await store.update((state) => {
    state.jobs.push(job);
    state.runs.push(run);
  });
  return { directory, store, release, job, run };
}

async function manifest(directory: string) {
  return JSON.parse(
    await fs.readFile(join(directory, "scheduler-journal.json"), "utf8"),
  );
}

async function commitAutomationRun(
  store: ReturnType<typeof createFileSchedulerStore>,
  runId: string,
) {
  await store.updateWithAutomations!((scheduler, automation) => {
    const run = scheduler.runs.find((item) => item.id === runId)!;
    run.status = "succeeded";
    run.finishedAt = "2026-09-29T09:01:00.000Z";
    automation.executions.push({
      id: runId,
      automationId: "automation",
      definitionRevision: 1,
      revision: 1,
      inputIds: [],
      nodes: [{ nodeId: "step", status: "succeeded", resultRef: "result" }],
      reportRef: "result",
    });
    automation.results.push({
      id: "result",
      runId,
      kind: "report",
      storageRef: "runtime-owned-report-reference",
      digest: "sha256:report",
      sizeBytes: 8,
      createdAt: "2026-09-29T09:01:00.000Z",
    });
  });
}

test("root run and automation checkpoint commit together while public snapshot stays v1", async () => {
  const f = await fixture();
  await commitAutomationRun(f.store, f.run.id);
  const head = await manifest(f.directory);
  expect(head.schemaVersion).toBe(4);
  const unowned = createFileSchedulerStore(f.directory);
  expect((await unowned.read()).schemaVersion).toBe(1);
  expect((await unowned.read()).runs[0].status).toBe("succeeded");
  expect((await unowned.read("active")).runs).toEqual([]);
  expect((await unowned.readAutomations!()).executions[0].reportRef).toBe(
    "result",
  );
  expect((await unowned.readAutomations!()).results[0].storageRef).toBe(
    "runtime-owned-report-reference",
  );
  const checkpoint = await fs.readFile(
    join(f.directory, head.generation, "checkpoints", head.checkpoint.file),
    "utf8",
  );
  expect(JSON.parse(checkpoint).version).toBe(2);
  expect(checkpoint).not.toContain("runtime-owned-report-reference");
});

test("grant revisions and input claims persist; removed input payload is retired", async () => {
  const f = await fixture();
  await f.store.updateAutomations!((state) => {
    state.grants.push({
      id: "grant",
      automationId: "automation",
      environmentId: "test",
      grantRevision: 1,
      mode: "full_access",
      operations: [
        { toolName: "reader", operationId: "read", contractVersion: 1 },
      ],
      evidence: {
        kind: "authenticated_user_action",
        actionId: "action-1",
        at: "2026-09-29T08:00:00.000Z",
      },
    });
    state.inputs.push({
      eligibility: "eligible",
      id: "input-1",
      automationId: "automation",
      sourceId: "source",
      canonicalPath: "/selected/receipt.pdf",
      contentVersion: "sha256:input",
      observedAt: "2026-09-29T08:00:00.000Z",
      snapshot: {
        attachment: {
          id: "attachment-1",
          kind: "file",
          mimeType: "application/pdf",
          storageRef: "runtime-owned-input-reference",
        },
        contentVersion: "sha256:input",
        sizeBytes: 100,
      },
    });
  });
  await expect(
    f.store.updateAutomations!((state) => {
      state.grants[0] = { ...state.grants[0], mode: "full_plus" };
    }),
  ).rejects.toThrow("scheduler_store_corrupt");
  await f.store.updateAutomations!((state) => {
    state.grants[0] = {
      ...state.grants[0],
      grantRevision: 2,
      mode: "full_plus",
      evidence: {
        kind: "authenticated_user_action",
        actionId: "action-2",
        at: "2026-09-29T08:01:00.000Z",
      },
    };
    state.inputs[0] = { ...state.inputs[0], claimRunId: f.run.id };
  });
  const unowned = createFileSchedulerStore(f.directory);
  expect((await unowned.readAutomations!()).grants[0].grantRevision).toBe(2);
  expect((await unowned.readAutomations!()).inputs[0].claimRunId).toBe(
    f.run.id,
  );
  const priorGeneration = (await manifest(f.directory)).generation;
  await f.store.updateAutomations!((state) => {
    state.inputs = [];
  });
  expect((await unowned.readAutomations!()).inputs).toEqual([]);
  await expect(
    fs.access(join(f.directory, priorGeneration)),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("pre-manifest combined commit exposes neither the terminal run nor report", async () => {
  const f = await fixture();
  const before = await manifest(f.directory);
  faults.syncPath = join(f.directory, before.generation);
  await expect(commitAutomationRun(f.store, f.run.id)).rejects.toThrow(
    "directory_sync",
  );
  faults.syncPath = "";
  expect(await manifest(f.directory)).toEqual(before);
  expect((await f.store.read()).runs[0].status).toBe("pending");
  expect((await f.store.readAutomations!()).results).toEqual([]);
  expect(
    (await createFileSchedulerStore(f.directory).read()).runs[0].status,
  ).toBe("pending");
});

test("post-manifest uncertainty blocks cached facets until reacquisition", async () => {
  const f = await fixture();
  faults.syncPath = f.directory;
  await expect(commitAutomationRun(f.store, f.run.id)).rejects.toThrow(
    "directory_sync",
  );
  faults.syncPath = "";
  await expect(f.store.read()).rejects.toThrow("directory_sync");
  await expect(f.store.readAutomations!()).rejects.toThrow("directory_sync");
  await expect(f.store.updateAutomations!(() => undefined)).rejects.toThrow(
    "directory_sync",
  );
  await f.release();
  const reopened = createFileSchedulerStore(f.directory);
  const release = await reopened.acquire();
  cleanups.push(release);
  expect((await reopened.read()).runs[0].status).toBe("succeeded");
  expect((await reopened.readAutomations!()).results).toHaveLength(1);
});

test("v3 checkpoint migrates to v4 without dropping the old scheduler data", async () => {
  const f = await fixture();
  const oldHead = await manifest(f.directory);
  const checkpointPath = join(
    f.directory,
    oldHead.generation,
    "checkpoints",
    oldHead.checkpoint.file,
  );
  const oldCheckpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
  delete oldCheckpoint.automations;
  oldCheckpoint.version = 1;
  await fs.writeFile(checkpointPath, JSON.stringify(oldCheckpoint));
  await fs.writeFile(
    join(f.directory, "scheduler-journal.json"),
    JSON.stringify({ ...oldHead, schemaVersion: 3 }),
  );
  await f.release();
  const store = createFileSchedulerStore(f.directory);
  faults.rejectManifestRename = true;
  await expect(store.acquire()).rejects.toThrow(
    "injected_manifest_rename_failure",
  );
  expect((await manifest(f.directory)).schemaVersion).toBe(3);
  expect((await store.read()).runs[0].id).toBe(f.run.id);
  faults.rejectManifestRename = false;
  const release = await store.acquire();
  cleanups.push(release);
  expect((await manifest(f.directory)).schemaVersion).toBe(4);
  expect((await store.read()).runs[0].id).toBe(f.run.id);
  expect(await store.readAutomations!()).toEqual({
    schemaVersion: 1,
    drafts: [],
    definitions: [],
    savedAgents: [],
    grants: [],
    inputs: [],
    executions: [],
    attempts: [],
    results: [],
  });
});
