import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCoWorkerResourceDependencies } from "../adapters/co-worker-resources.js";
import { createRuntimePassiveLearningModel } from "../passive-learning/model.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createPendingLearningBatch } from "../passive-learning/batch-lifecycle.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningMemoryService } from "../long-term-memory/maturation/contracts.js";
import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";

vi.mock("../passive-learning/model.js", () => ({ createRuntimePassiveLearningModel: vi.fn(() => ({
  validateProfile() {}, supportsParallelBatches: () => false, extract: async () => [],
})) }));

const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(initial: { enabled: boolean; available: boolean }) {
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-memory-availability-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "fixture-")); roots.push(directory);
  let availability = initial;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({ text: "ok", meta: {} }));
  const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>(async () => ({ text: "ok", meta: { status: 200, outputLength: 2, thinkingLength: 0 } }));
  const embed = vi.fn<NonNullable<ModelGatewayClient["embed"]>>(async () => ({ profileId: "embedding", provider: "ollama", model: "embedding",
    modelFingerprint: "one", dimensions: 1, vectors: [[1]] }));
  const embedded = vi.fn();
  const learning = { prepare: async (input: Parameters<LearningMemoryService["prepare"]>[0]) => {
    const release = await input.beforeEmbedding?.({ characters: input.query.length, signal: input.abortSignal });
    try { embedded(); return {}; } finally { release?.(); }
  } } as unknown as LearningMemoryService;
  const status = vi.fn(async () => ({ ...availability, recordCount: 1, indexedRecordCount: 1 }));
  const memory = { status, learning } as unknown as LongTermMemoryService;
  const dependencies = createCoWorkerResourceDependencies({ directory, ownerId: "owner", memory,
    config: {} as RuntimeConfig, models: { invoke, invokeRaw, embed },
    context: { preferences: () => ({ ...DEFAULT_LEARNING_PREFERENCES, processingPaused: false, modelProfileId: "learning" }),
      isStarted: () => true, isInteractiveBusy: () => false, assertProcessingAllowed() {}, changed() {} } });
  const gateway = vi.mocked(createRuntimePassiveLearningModel).mock.calls.at(-1)![0].models;
  return { directory, dependencies, gateway, invoke, invokeRaw, embed, embedded, status,
    setAvailability: (next: typeof initial) => { availability = next; } };
}

describe("Co-worker processing memory availability", () => {
  test("retains queued work after a runtime memory outage and retries only at the configured cadence", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    const f = await fixture({ enabled: true, available: true });
    const batch = createPendingLearningBatch([{ id: "evidence", timestamp: new Date().toISOString(), sequence: 1,
      deviceId: "computer", source: { app: "Editor", windowId: "1" }, content: "Project note",
      kind: "view", extraction: "uia", coverage: "complete" }], "previous", Date.now());
    await createLearningStateStore(f.directory).write({ schemaVersion: 1, batches: [batch],
      preferences: { ...DEFAULT_LEARNING_PREFERENCES, processingPaused: false, modelProfileId: "learning", analysisIntervalMinutes: 1 } });
    const save = vi.fn<NonNullable<LongTermMemoryService["saveObservationBatch"]>>(async (input) =>
      ({ batchId: input.batchId, recordIds: [], createdAt: new Date().toISOString() }));
    const memory = { ...f.dependencies.memory, learning: undefined, saveObservationBatch: save };
    const extract = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await f.gateway.invoke({ abortSignal: signal } as Parameters<ModelGatewayClient["invoke"]>[0]);
      return [];
    });
    const model = { validateProfile() {}, extract };
    const service = createPassiveLearningService({ directory: f.directory, ownerId: "owner", memory, model,
      connect: async () => ({ close() {} }),
      backgroundDependencies: () => ({ memory, model, resourceUsage: f.dependencies.resourceUsage }) });
    try {
      await service.start(); f.setAvailability({ enabled: true, available: false });
      await service.flush();
      expect((await service.batches())[0]).toMatchObject({ id: batch.id, status: "pending", reason: "learning_memory_unavailable" });
      expect((await service.status()).pendingObservations).toBe(1);
      expect((await createLearningStateStore(f.directory).read()).batches[0]?.observations).toEqual(batch.observations);
      expect(f.invoke).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
      expect(await f.dependencies.resourceUsage!()).toMatchObject({ modelCalls: 0, activeCalls: 0 });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(extract).toHaveBeenCalledOnce();
      f.setAvailability({ enabled: true, available: true });
      await vi.advanceTimersByTimeAsync(2);
      await vi.waitFor(async () => expect((await service.batches())[0]?.status).toBe("discarded"));
      expect((await service.status()).pendingObservations).toBe(0);
      expect(f.invoke).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledOnce();
      expect(await f.dependencies.resourceUsage!()).toMatchObject({ modelCalls: 1, activeCalls: 0 });
    } finally { await service.stop(); }
  });

  test.each([{ enabled: false, available: true }, { enabled: true, available: false }])(
    "blocks generative and embedding calls before quota reservation when memory is $enabled/$available", async (status) => {
      const f = await fixture(status); const abortSignal = new AbortController().signal;
      await expect(f.gateway.invoke({ abortSignal } as Parameters<ModelGatewayClient["invoke"]>[0])).rejects.toThrow("learning_memory_unavailable");
      await expect(f.gateway.invokeRaw({ abortSignal } as Parameters<ModelGatewayClient["invokeRaw"]>[0])).rejects.toThrow("learning_memory_unavailable");
      await expect(f.gateway.embed!({ abortSignal, profileId: "embedding", texts: ["knowledge"] }))
        .rejects.toThrow("learning_memory_unavailable");
      await expect(f.dependencies.memory.learning!.prepare({ query: "knowledge", abortSignal })).rejects.toThrow("learning_memory_unavailable");
      expect(f.invoke).not.toHaveBeenCalled(); expect(f.invokeRaw).not.toHaveBeenCalled();
      expect(f.embed).not.toHaveBeenCalled(); expect(f.embedded).not.toHaveBeenCalled();
      expect(await f.dependencies.resourceUsage!()).toMatchObject({ modelCalls: 0, embeddingCalls: 0, activeCalls: 0 });
    },
  );

  test("checks the current memory state again before each paid operation", async () => {
    const f = await fixture({ enabled: true, available: true }); const abortSignal = new AbortController().signal;
    await f.gateway.invoke({ abortSignal } as Parameters<ModelGatewayClient["invoke"]>[0]);
    expect(f.invoke).toHaveBeenCalledOnce();
    f.setAvailability({ enabled: false, available: true });
    await expect(f.gateway.invokeRaw({ abortSignal } as Parameters<ModelGatewayClient["invokeRaw"]>[0])).rejects.toThrow("learning_memory_unavailable");
    await expect(f.dependencies.memory.learning!.prepare({ query: "knowledge", abortSignal })).rejects.toThrow("learning_memory_unavailable");
    expect(f.invokeRaw).not.toHaveBeenCalled(); expect(f.embedded).not.toHaveBeenCalled();
    expect(await f.dependencies.resourceUsage!()).toMatchObject({ modelCalls: 1, embeddingCalls: 0 });
  });
});
