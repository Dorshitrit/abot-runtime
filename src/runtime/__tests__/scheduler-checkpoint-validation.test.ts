import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import {
  committedCheckpointPath,
  createCheckpointFixture,
  readCheckpointManifest,
} from "./support/scheduler-checkpoint-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("checkpoint reopen retains full pending/running payloads and independent job/run order", async () => {
  const f = await createCheckpointFixture(cleanups, (snapshot) => {
    snapshot.jobs.reverse();
    snapshot.runs[0].status = "pending";
    snapshot.runs[1].status = "running";
    snapshot.runs[1].startedAt = "2026-09-06T09:00:01.000Z";
    for (const run of snapshot.runs) delete run.resultText;
  });
  const owner = await f.own();
  const head = await readCheckpointManifest(f.directory);
  expect(head.schemaVersion).toBe(3);
  expect(head.sequence).toBe(head.checkpoint!.sequence);
  expect(await owner.store.read("active")).toEqual(f.snapshot);
  await owner.close();
  expect(await f.fresh().read("active")).toEqual(f.snapshot);
  const reopened = await f.own();
  expect(await reopened.store.read()).toEqual(f.snapshot);
  expect(await reopened.store.read("active")).toEqual(f.snapshot);
  const detached = await reopened.store.read("active");
  detached.runs[0].prompt = "outside mutation";
  expect(await reopened.store.read("active")).toEqual(f.snapshot);
});

type CheckpointRunMetadata = Record<string, unknown>;
const malformedMetadata: Array<{
  name: string;
  mutate: (run: CheckpointRunMetadata) => void;
}> = [
  {
    name: "cross-session owner",
    mutate: (run) => {
      run.sessionId = "another-session";
    },
  },
  {
    name: "transaction path traversal",
    mutate: (run) => {
      run.file = "../0000000000000002.json";
    },
  },
  {
    name: "status with array coercion",
    mutate: (run) => {
      run.status = ["succeeded"];
    },
  },
];

test.each(malformedMetadata)(
  "checkpoint metadata rejects $name before exposing state",
  async ({ mutate }) => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    const head = await readCheckpointManifest(f.directory);
    const path = committedCheckpointPath(f.directory, head);
    await owner.close();
    const checkpoint = JSON.parse(await readFile(path, "utf8"));
    mutate(checkpoint.runs[0]);
    await writeFile(path, JSON.stringify(checkpoint));
    await expect(f.fresh().read("active")).rejects.toThrow(
      "scheduler_store_corrupt",
    );
    await expect(f.fresh().acquire()).rejects.toThrow(
      "scheduler_store_corrupt",
    );
  },
);

test("checkpoint active payload must match its indexed request identity", async () => {
  const f = await createCheckpointFixture(cleanups, (snapshot) => {
    snapshot.runs[0].status = "pending";
    delete snapshot.runs[0].resultText;
  });
  const owner = await f.own();
  const path = committedCheckpointPath(
    f.directory,
    await readCheckpointManifest(f.directory),
  );
  await owner.close();
  const checkpoint = JSON.parse(await readFile(path, "utf8"));
  checkpoint.runs[0].active.requestId = "different-request";
  await writeFile(path, JSON.stringify(checkpoint));
  await expect(f.fresh().read("active")).rejects.toThrow(
    "scheduler_store_corrupt",
  );
  await expect(f.fresh().acquire()).rejects.toThrow("scheduler_store_corrupt");
});

type CheckpointRecord = {
  generation: string;
  sequence: number;
  jobs: Record<string, unknown>[];
  runs: Record<string, unknown>[];
};
const invalidIndexCases: Array<[string, (value: CheckpointRecord) => void]> = [
  [
    "generation binding",
    (value) => {
      value.generation = "wrong";
    },
  ],
  [
    "covered sequence",
    (value) => {
      value.sequence += 1;
    },
  ],
  [
    "duplicate Job ID",
    (value) => {
      value.jobs.push(value.jobs[0]);
    },
  ],
  [
    "duplicate Run ID",
    (value) => {
      value.runs.push(value.runs[0]);
    },
  ],
  [
    "missing owner",
    (value) => {
      value.runs[0].jobId = "unknown";
    },
  ],
  [
    "wrong environment",
    (value) => {
      value.runs[0].environmentId = "other";
    },
  ],
  [
    "future Job revision",
    (value) => {
      value.runs[0].jobRevision = 10;
    },
  ],
  [
    "negative offset",
    (value) => {
      value.runs[0].offset = -1;
    },
  ],
  [
    "fractional offset",
    (value) => {
      value.runs[0].offset = 0.5;
    },
  ],
  [
    "unknown status",
    (value) => {
      value.runs[0].status = "invented";
    },
  ],
  [
    "uncommitted transaction",
    (value) => {
      value.runs[0].file = "0000000000000003.json";
    },
  ],
  [
    "missing active payload",
    (value) => {
      value.runs[0].status = "running";
    },
  ],
];

test.each(invalidIndexCases)(
  "checkpoint restore rejects %s before exposing state",
  async (_name, damage) => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    await owner.close();
    const path = committedCheckpointPath(
      f.directory,
      await readCheckpointManifest(f.directory),
    );
    const value = JSON.parse(await readFile(path, "utf8")) as CheckpointRecord;
    damage(value);
    await writeFile(path, JSON.stringify(value));
    await expect(f.fresh().read("active")).rejects.toThrow(
      "scheduler_store_corrupt",
    );
  },
);
