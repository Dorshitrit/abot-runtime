import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPassiveLearningService } from "../passive-learning/service.js";
import type {
  PassiveLearningConnection,
  PassiveLearningModel,
  PassiveLearningService,
} from "../passive-learning/contracts.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
});

async function fixture(
  extract?: PassiveLearningModel["extract"],
  parallel = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "learning-test-"));
  const repository = createInMemoryLongTermMemoryRepository();
  const memory = createLongTermMemoryService({
    repository,
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
  const model = {
    validateProfile: vi.fn(),
    supportsParallelBatches: () => parallel,
    extract: vi.fn(
      extract ??
        (async ({ observations }) => [
          {
            content: "Uses an editor for development.",
            tags: [],
            observationIds: [observations[0]!.id],
            reason: "Observed context",
            certainty: "observed" as const,
          },
        ]),
    ),
  };
  let source: Parameters<PassiveLearningConnection>[0];
  const connect = vi.fn<PassiveLearningConnection>(async (input) => {
    source = input;
    return { close() {} };
  });
  const service = createPassiveLearningService({
    directory: join(directory, "learning"),
    ownerId: "env",
    memory,
    model,
    connect,
  });
  cleanup.push(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await service.start();
  async function enable() {
    await service.configure({ enabled: true, processingPaused: false, modelProfileId: "model" });
  }
  function observe(id = "one", sequence = 1, content = "Development notes") {
    source!.onEvent({
      type: "observation",
      deviceId: "device",
      ownerId: "env",
      leaseId: source!.leaseId,
      observation: {
        id,
        timestamp: new Date().toISOString(),
        sequence,
        source: { app: "editor", windowId: "one" },
        content,
        kind: "view",
        extraction: "uia",
        coverage: "complete",
      },
    });
  }
  return {
    service,
    memory,
    repository,
    model,
    directory,
    enable,
    observe,
    connect,
    source: () => source!,
  };
}

describe("passive learning lifecycle", () => {
  it("retains a processing error through collector updates until a batch succeeds", async () => {
    const f = await fixture();
    await f.enable();
    f.model.extract.mockRejectedValueOnce(new Error("output_incomplete"));
    f.observe();
    await f.service.flush();
    const source = f.source();
    source.onEvent({ type: "status", deviceId: "device", ownerId: "env",
      leaseId: source.leaseId, state: "partial", reason: "uia_application_coverage" });
    expect(await f.service.status()).toMatchObject({ state: "failed", reason: "output_incomplete" });
    f.observe("two", 2, "Another project note");
    await f.service.flush();
    expect(await f.service.status()).toMatchObject({ state: "partial", reason: "uia_application_coverage" });
  });
  it("starts disabled without storage writes or model activity", async () => {
    const { service, directory, model, connect } = await fixture();
    expect(await service.status()).toMatchObject({
      state: "off", processing: false,
      preferences: { enabled: false, processingPaused: true, proactiveEnabled: false },
    });
    expect((await service.status()).preferences.modelProfileId).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(model.extract).not.toHaveBeenCalled();
    await expect(access(join(directory, "learning"))).rejects.toThrow();
  });
  it("commits a batch and shows canonical records, removing previews after user deletion", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-09-23T10:00:00.000Z");
    vi.setSystemTime(start);
    const { service, memory, model, enable, observe } = await fixture();
    const review: NonNullable<PassiveLearningModel["review"]> = async ({ observations, context }) => {
      const target = context.entries.find(({ kind }) => kind === "candidate");
      return [{
        action: target ? "update" : "create", targetKind: "candidate",
        targetId: target?.id ?? null, targetVersion: target?.version ?? null,
        content: "Prefers concise development explanations.", tags: [], score: 95,
        reason: "Independent evidence of a lasting preference.", certainty: "observed",
        observationIds: [observations[0]!.id], reinforced: true,
        mergedCandidateIds: [], reconsiderAt: null,
      }];
    };
    Object.assign(model, { review });
    await enable();
    for (let index = 0; index < 2; index += 1) {
      vi.setSystemTime(start + index * 12 * 60 * 60 * 1000);
      observe(`opportunity-${index}`, index + 1, `Independent preference evidence ${index}`);
      await service.flush();
      if (index === 0) {
        expect((await memory.list()).total).toBe(0);
        expect(await memory.learning!.list()).toHaveLength(1);
        expect((await service.status()).recentMemories).toEqual([]);
      }
    }
    const batches = await service.batches();
    const promoted = batches.find(({ status }) => status === "saved")!;
    expect(promoted).toMatchObject({ status: "saved", observationCount: 1 });
    expect(promoted).not.toHaveProperty("observations");
    expect((await service.batch(promoted.id))!.observations).toHaveLength(1);
    expect((await service.status()).recentMemories).toHaveLength(1);
    await memory.delete({ id: promoted.recordIds[0]! });
    expect((await service.status()).recentMemories).toEqual([]);
  });
  it("ignores stale leases and duplicate observation events", async () => {
    const { service, model, enable, observe, source } = await fixture();
    await enable();
    observe();
    observe("duplicate", 2);
    await service.flush();
    expect(model.extract).toHaveBeenCalledTimes(1);
    const old = source();
    await service.configure({ enabled: false });
    old.onEvent({
      type: "status",
      deviceId: "device",
      ownerId: "env",
      leaseId: old.leaseId,
      state: "collecting",
    });
    expect((await service.status()).state).toBe("off");
  });
  it("cancels late model output only on explicit pending deletion", async () => {
    let finish!: (value: readonly []) => void;
    const { service, memory, enable, observe, model } = await fixture(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await enable();
    observe();
    const work = service.flush();
    await vi.waitFor(() => expect(model.extract).toHaveBeenCalledOnce());
    const disabled = service.clearPending();
    await new Promise((resolve) => setImmediate(resolve));
    finish([]);
    await work;
    await disabled;
    expect((await memory.list()).total).toBe(0);
    expect(await service.batches()).toEqual([]);
  });
  it("defers model work during interactive use and resumes without dropping observations", async () => {
    const { service, enable, observe, model } = await fixture();
    await enable();
    const release = service.beginInteractive();
    observe();
    await service.flush();
    expect(model.extract).not.toHaveBeenCalled();
    release();
    await service.flush();
    expect(model.extract).toHaveBeenCalledOnce();
  });
  it("expires retained raw observations on disk even with collection disabled", async () => {
    vi.useFakeTimers();
    const { service, enable, observe, directory } = await fixture();
    await enable();
    observe();
    await service.flush();
    await service.configure({ enabled: false });
    await vi.advanceTimersByTimeAsync(86_400_002);
    await vi.waitFor(async () => {
      const state = JSON.parse(
        await readFile(join(directory, "learning", "state.json"), "utf8"),
      );
      expect(state.batches).toEqual([]);
    });
  });
  it("accepts a restarted collector sequence and ignores callbacks from the old subscription", async () => {
    vi.useFakeTimers();
    const { service, enable, observe, source, connect, model } =
      await fixture();
    await enable();
    observe("old", 20);
    await service.flush();
    const first = source();
    first.onEvent({
      type: "status",
      state: "disconnected",
      deviceId: "device",
      ownerId: "env",
      leaseId: first.leaseId,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(2);
    first.onEvent({
      type: "status",
      state: "failed",
      deviceId: "device",
      ownerId: "env",
      leaseId: first.leaseId,
    });
    expect((await service.status()).state).toBe("starting");
    observe("new", 1, "New document content");
    await service.flush();
    expect(model.extract).toHaveBeenCalledTimes(2);
  });
  it("cleans expired disk evidence after status reads and after restarting the same service", async () => {
    vi.useFakeTimers();
    const { service, enable, observe, directory } = await fixture();
    await enable();
    observe();
    await service.flush();
    await service.configure({ enabled: false });
    vi.setSystemTime(Date.now() + 86_400_002);
    expect(await service.batches()).toEqual([]);
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(async () =>
      expect(
        JSON.parse(
          await readFile(join(directory, "learning", "state.json"), "utf8"),
        ).batches,
      ).toEqual([]),
    );
    await enable();
    observe("later", 1, "Later evidence");
    await service.flush();
    await service.stop();
    vi.setSystemTime(Date.now() + 86_400_002);
    await service.start();
    expect(
      JSON.parse(
        await readFile(join(directory, "learning", "state.json"), "utf8"),
      ).batches,
    ).toEqual([]);
  });
  it("exposes metadata-only failures without provider output text", async () => {
    const { service, enable, observe } = await fixture(async () => {
      throw new Error("provider echoed private screen text");
    });
    await enable();
    observe();
    await service.flush();
    expect((await service.batches())[0]).toMatchObject({
      status: "failed",
      reason: "learning_failed",
    });
  });
  it("dispatches only fresh pending data at the configured cadence", async () => {
    vi.useFakeTimers();
    const { service, enable, observe, model } = await fixture();
    await enable();
    await service.configure({ analysisIntervalMinutes: 1 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(model.extract).not.toHaveBeenCalled();
    observe();
    const due = (await service.status()).nextAnalysisAt;
    expect(due).toBe(new Date(Date.now() + 60_000).toISOString());
    await vi.advanceTimersByTimeAsync(59_000);
    expect(model.extract).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(model.extract).toHaveBeenCalledOnce());
    await vi.waitFor(async () =>
      expect((await service.status()).processing).toBe(false),
    );
    await vi.advanceTimersByTimeAsync(180_000);
    expect(model.extract).toHaveBeenCalledOnce();
  });
  it("defers queued data outside the allowed window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T22:00:00Z"));
    const { service, enable, observe, model } = await fixture();
    await enable();
    await service.configure({
      analysisIntervalMinutes: 1,
      analysisWindow: { start: "08:00", end: "20:00", timeZone: "UTC" },
    });
    observe();
    await service.flush();
    expect(model.extract).not.toHaveBeenCalled();
    expect((await service.status()).nextAnalysisAt).toBe(
      "2026-09-24T08:00:00.000Z",
    );
    await vi.advanceTimersByTimeAsync(10 * 60 * 60_000);
    await vi.waitFor(() => expect(model.extract).toHaveBeenCalledOnce());
  });
  it("keeps local or unknown providers serial despite configured parallelism", async () => {
    let finish!: (value: readonly []) => void;
    const { service, enable, observe, model } = await fixture(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await enable();
    await service.configure({ maxConcurrentBatches: 3 });
    for (let index = 1; index <= 33; index += 1)
      observe(`observation-${index}`, index, `Content ${index}`);
    const work = service.flush();
    await vi.waitFor(() => expect(model.extract).toHaveBeenCalledOnce());
    expect(await service.status()).toMatchObject({
      activeBatches: 1,
      effectiveConcurrency: 1,
      pendingObservations: 17,
    });
    finish([]);
    await work;
  });
  it("preempts every cloud batch and reuses durable batch identities on resume", async () => {
    let block = true;
    const { service, memory, enable, observe, model } = await fixture(
      async ({ signal }) => {
        if (!block) return [];
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
      true,
    );
    await enable();
    await service.configure({ maxConcurrentBatches: 2 });
    for (let index = 1; index <= 32; index += 1)
      observe(`observation-${index}`, index, `Content ${index}`);
    const work = service.flush();
    await vi.waitFor(() => expect(model.extract).toHaveBeenCalledTimes(2));
    expect(await service.status()).toMatchObject({
      activeBatches: 2,
      effectiveConcurrency: 2,
    });
    const release = service.beginInteractive();
    await work;
    const pending = await service.batches();
    expect(pending.map(({ status }) => status)).toEqual(["pending", "pending"]);
    expect((await memory.list()).total).toBe(0);
    block = false;
    release();
    await service.flush();
    expect(model.extract).toHaveBeenCalledTimes(4);
    expect((await service.batches()).map(({ id }) => id).sort()).toEqual(
      pending.map(({ id }) => id).sort(),
    );
    expect((await service.status()).activeBatches).toBe(0);
  });
});
