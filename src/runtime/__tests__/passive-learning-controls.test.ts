import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSIVE_OBSERVATION_RETENTION_MS } from "../../shared/passive-observation.js";
import { createFileLongTermMemoryRepository } from "../adapters/long-term-memory/file-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createLearningStateStore } from "../passive-learning/store.js";
import type {
  LearningBatch,
  PassiveLearningConnection,
  PassiveLearningModel,
  PassiveLearningService,
} from "../passive-learning/contracts.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
});

function proposals(input: Parameters<PassiveLearningModel["extract"]>[0]) {
  return [
    {
      content: `Development context from ${input.observations[0]!.id}.`,
      tags: [],
      observationIds: [input.observations[0]!.id],
      reason: "Observed workflow",
      certainty: "observed" as const,
    },
  ];
}

async function fixture() {
  vi.useFakeTimers();
  const directory = await mkdtemp(join(tmpdir(), "learning-controls-"));
  const memory = createLongTermMemoryService({
    repository: createFileLongTermMemoryRepository(join(directory, "memory")),
    enabled: true,
    emitClientEvents: false,
    embeddings: {
      async embed({ texts }) {
        return {
          modelFingerprint: "test",
          dimensions: 2,
          vectors: texts.map(() => [1, 0]),
        };
      },
    },
  });
  const extract = vi.fn<PassiveLearningModel["extract"]>(async (input) =>
    proposals(input),
  );
  let source: Parameters<PassiveLearningConnection>[0];
  const connect = vi.fn<PassiveLearningConnection>(async (input) => {
    source = input;
    return { close() {} };
  });
  const services: PassiveLearningService[] = [];
  const journal = createLearningStateStore(join(directory, "learning"));
  const open = () => {
    const service = createPassiveLearningService({
      directory: join(directory, "learning"),
      ownerId: "env",
      memory,
      model: { validateProfile() {}, extract },
      connect,
      batchDelayMs: 60_000,
    });
    services.push(service);
    return service;
  };
  cleanup.push(async () => {
    for (const service of services) await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  function observe(id: string) {
    source!.onEvent({
      type: "observation",
      deviceId: "device",
      ownerId: "env",
      leaseId: source!.leaseId,
      observation: {
        id,
        timestamp: new Date().toISOString(),
        sequence: ++sequence,
        source: { app: "editor", windowId: "one" },
        content: `Evidence for ${id}`,
        kind: "view",
        extraction: "uia",
        coverage: "complete",
      },
    });
  }
  async function enable(service: PassiveLearningService) {
    await service.start();
    await service.configure({
      enabled: true,
      processingPaused: false,
      modelProfileId: "model",
    });
  }
  function blockNext() {
    let finish!: () => void;
    extract.mockImplementationOnce(
      (input) =>
        new Promise((resolve, reject) => {
          finish = () => resolve(proposals(input));
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          );
        }),
    );
    return () => finish();
  }
  return {
    open,
    enable,
    observe,
    extract,
    memory,
    journal,
    blockNext,
    source: () => source!,
    connect,
  };
}

describe("independent passive learning controls", () => {
  it("stops collection while finishing active and queued reviews at the existing cadence", async () => {
    const test = await fixture();
    const service = test.open();
    await test.enable(service);
    const finish = test.blockNext();
    for (let index = 0; index < 17; index++) test.observe(`source-${index}`);
    const due = Date.now() + 60_000;
    const active = service.flush();
    await vi.waitFor(() => expect(test.extract).toHaveBeenCalledOnce());
    const signal = test.extract.mock.calls[0]![0].signal;
    await service.configure({ enabled: false });
    expect(signal.aborted).toBe(false);
    expect(test.source().abortSignal.aborted).toBe(true);
    expect(await service.status()).toMatchObject({
      pendingObservations: 1,
      processing: true,
    });
    test.observe("ignored-after-stop");
    finish();
    await active;
    expect((await service.status()).nextAnalysisAt).toBe(
      new Date(due).toISOString(),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () =>
      expect(
        (await service.batches()).every(({ status }) => status === "reviewed"),
      ).toBe(true),
    );
    expect(test.extract).toHaveBeenCalledTimes(2);
    expect(
      test.extract.mock.calls.flatMap(([input]) => input.observations),
    ).toHaveLength(17);
    expect(await test.memory.learning!.list()).toHaveLength(2);
    expect((await test.memory.list()).total).toBe(0);
  });

  it("pauses active analysis, continues collection, and resumes the same batch identity", async () => {
    const test = await fixture();
    const service = test.open();
    await test.enable(service);
    test.blockNext();
    test.observe("before-pause");
    const active = service.flush();
    await vi.waitFor(() => expect(test.extract).toHaveBeenCalledOnce());
    const batchId = test.extract.mock.calls[0]![0].batchId;
    await service.configure({ processingPaused: true });
    await active;
    expect(test.extract.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(test.source().abortSignal.aborted).toBe(false);
    expect(await service.batch(batchId)).toMatchObject({
      id: batchId,
      status: "pending",
    });
    test.observe("during-pause");
    await service.flush();
    expect(test.extract).toHaveBeenCalledOnce();
    expect((await service.status()).pendingObservations).toBe(2);
    await service.configure({ processingPaused: false });
    await service.flush();
    await service.flush();
    expect(test.extract.mock.calls[1]![0].batchId).toBe(batchId);
    expect(await test.memory.learning!.list()).toHaveLength(2);
    expect((await test.memory.list()).total).toBe(0);
    expect((await service.status()).pendingObservations).toBe(0);
  });

  it("deletes only pending evidence and aborts an uncommitted review without removing saved memories", async () => {
    const test = await fixture();
    const { record: retainedMemory } = await test.memory.create({
      content: "A user-managed preference.", tags: [], source: "web_ui",
      context: { abortSignal: new AbortController().signal },
    });
    const service = test.open();
    await test.enable(service);
    test.observe("committed");
    await service.flush();
    const saved = (await service.batches())[0]!;
    const retainedCandidates = await test.memory.learning!.list();
    test.blockNext();
    for (let index = 0; index < 17; index++) test.observe(`pending-${index}`);
    const active = service.flush();
    await vi.waitFor(() => expect(test.extract).toHaveBeenCalledTimes(2));
    await service.clearPending();
    await active;
    expect(test.extract.mock.calls[1]![0].signal.aborted).toBe(true);
    expect(await service.batches()).toEqual([saved]);
    expect((await service.status()).pendingObservations).toBe(0);
    expect((await test.memory.list()).items.map(({ id }) => id)).toEqual(
      [retainedMemory.id],
    );
    expect(await test.memory.learning!.list()).toEqual(retainedCandidates);
    await service.flush();
    expect(test.extract).toHaveBeenCalledTimes(2);
    test.observe("new-after-delete");
    await service.flush();
    expect(await test.memory.learning!.list()).toHaveLength(2);
    expect((await test.memory.list()).items.map(({ id }) => id)).toEqual([retainedMemory.id]);
  });

  it.each([false, true])(
    "preserves pending identities through stop and restart (new instance: %s)",
    async (newInstance) => {
      const test = await fixture();
      const original = test.open();
      await test.enable(original);
      test.blockNext();
      for (let index = 0; index < 17; index++) test.observe(`restart-${index}`);
      const active = original.flush();
      await vi.waitFor(() => expect(test.extract).toHaveBeenCalledOnce());
      await original.stop();
      await active;
      const persisted = (await test.journal.read()).batches;
      expect(persisted).toHaveLength(2);
      expect(persisted.every(({ status }) => status === "pending")).toBe(true);
      const resumed = newInstance ? test.open() : original;
      await resumed.start();
      await resumed.flush();
      await resumed.flush();
      expect(
        test.extract.mock.calls
          .slice(1)
          .map(([input]) => input.batchId)
          .sort(),
      ).toEqual(persisted.map(({ id }) => id).sort());
      expect(
        (await resumed.batches()).every(({ status }) => status === "reviewed"),
      ).toBe(true);
      expect(await test.memory.learning!.list()).toHaveLength(2);
      expect((await test.memory.list()).total).toBe(0);
    },
  );

  it.each(["paused", "interactive"])(
    "expires raw queued evidence independently while %s",
    async (mode) => {
      const test = await fixture();
      const service = test.open();
      await test.enable(service);
      const release =
        mode === "interactive" ? service.beginInteractive() : () => {};
      if (mode === "paused")
        await service.configure({ processingPaused: true });
      test.observe("expires-without-status-read");
      const changed = vi.fn();
      service.subscribe(changed);
      await vi.advanceTimersByTimeAsync(PASSIVE_OBSERVATION_RETENTION_MS);
      // This notification precedes status(), proving expiry is not read-driven.
      expect(changed).toHaveBeenCalledOnce();
      expect(await service.status()).toMatchObject({
        pendingObservations: 0,
        droppedObservations: 1,
      });
      expect(test.extract).not.toHaveBeenCalled();
      release();
    },
  );

  it("migrates legacy Off preferences to paused processing until explicitly resumed", async () => {
    const test = await fixture();
    const timestamp = new Date().toISOString();
    const batch: LearningBatch = {
      id: "legacy-pending",
      generation: "previous-owner",
      createdAt: timestamp,
      status: "pending",
      recordIds: [],
      observations: [
        {
          id: "legacy-source",
          deviceId: "device",
          timestamp,
          sequence: 1,
          source: { app: "editor", windowId: "one" },
          content: "Existing context",
          kind: "view",
          extraction: "uia",
          coverage: "complete",
        },
      ],
    };
    await test.journal.write({
      schemaVersion: 1,
      preferences: {
        enabled: false,
        modelProfileId: "model",
        excludedApplications: [],
      },
      batches: [batch],
    });
    const service = test.open();
    await service.start();
    await service.flush();
    expect((await service.status()).preferences).toMatchObject({
      enabled: false,
      processingPaused: true,
    });
    expect(test.extract).not.toHaveBeenCalled();
    expect(test.connect).not.toHaveBeenCalled();
    await service.configure({ processingPaused: false });
    await service.flush();
    expect(test.extract.mock.calls[0]![0].batchId).toBe(batch.id);
    expect(await test.memory.learning!.list()).toHaveLength(1);
    expect((await test.memory.list()).total).toBe(0);
  });
});
