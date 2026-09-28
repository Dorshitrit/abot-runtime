import { describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type { LongTermMemoryEmbeddingClient } from "../long-term-memory/contracts.js";
import type { SaveObservationMemoryInput } from "../long-term-memory/observation-contracts.js";
import { saveObservationMemoryBatch } from "../long-term-memory/observation-persistence.js";
import { parseMemorySnapshot } from "../long-term-memory/repository-state.js";
import { PASSIVE_OBSERVATION_RETENTION_MS } from "../../shared/passive-observation.js";
import { createLearningMemoryService } from "../long-term-memory/maturation/service.js";

function fixture() {
  let clock = Date.parse("2026-09-24T12:00:00Z");
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn<LongTermMemoryEmbeddingClient["embed"]>(
    async ({ texts }) => ({
      modelFingerprint: "test",
      dimensions: 2,
      vectors: texts.map(() => [1, 0]),
    }),
  );
  const input: SaveObservationMemoryInput = {
    batchId: "batch",
    batchExpiresAt: new Date(clock + 60_000).toISOString(),
    environmentId: "env",
    abortSignal: new AbortController().signal,
    observations: [
      {
        id: "source",
        deviceId: "device",
        timestamp: new Date(clock).toISOString(),
      },
    ],
    proposals: [
      {
        content: "Uses TypeScript for development.",
        tags: [],
        observationIds: ["source"],
        reason: "Observed workflow",
        certainty: "observed",
      },
    ],
  };
  const learning = createLearningMemoryService({ repository, embeddings: { embed }, now: () => new Date(clock) });
  const save = (value = input) =>
    saveObservationMemoryBatch({
      repository,
      learning,
      input: value,
      now: () => new Date(clock),
    });
  return {
    repository,
    embed,
    input,
    save,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("passive observation replay receipt retention", () => {
  it("prunes expired receipts while retaining every live replay and legacy receipt", async () => {
    const { repository, input, save, now } = fixture();
    const timestamp = new Date(now()).toISOString();
    const expiredLegacy = new Date(
      now() - PASSIVE_OBSERVATION_RETENTION_MS - 1,
    ).toISOString();
    const liveReceipts = Array.from({ length: 60 }, (_, index) => ({
      batchId: `live-${index}`,
      recordIds: [],
      createdAt: expiredLegacy,
      expiresAt: input.batchExpiresAt,
    }));
    await repository.update((state) => ({
      ...state,
      observationReceipts: [
        ...liveReceipts,
        {
          batchId: "expired",
          recordIds: [],
          createdAt: timestamp,
          expiresAt: timestamp,
        },
        { batchId: "legacy-expired", recordIds: [], createdAt: expiredLegacy },
        { batchId: "legacy-live", recordIds: [], createdAt: timestamp },
      ],
    }));
    await save();
    const snapshot = await repository.read();
    expect(snapshot.observationReceipts?.map(({ batchId }) => batchId)).toEqual(
      [...liveReceipts.map(({ batchId }) => batchId), "legacy-live"],
    );
    expect(snapshot.learningReceipts?.map(({ batchId }) => batchId)).toEqual(["batch"]);
    expect(parseMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(
      snapshot,
    );
  });

  it("keeps deduplication until expiry and cannot resurrect deleted memories after pruning", async () => {
    const { repository, embed, input, save, now, advance } = fixture();
    const receipt = await save();
    await repository.update((state) => ({
      ...state,
      records: [],
      vectors: [],
      learningCandidates: [],
    }));
    advance(59_999);
    expect(await save()).toEqual(receipt);
    expect(embed).toHaveBeenCalledOnce();
    advance(1);
    await save({
      ...input,
      batchId: "next",
      batchExpiresAt: new Date(now() + 60_000).toISOString(),
      proposals: [],
    });
    expect(
      (await repository.read()).learningReceipts?.map(
        ({ batchId }) => batchId,
      ),
    ).toEqual(["next"]);
    await expect(save()).rejects.toThrow("learning_batch_expired");
    expect((await repository.read()).records).toEqual([]);
    expect(embed).toHaveBeenCalledOnce();
  });

  it("rejects an expired or invalid deadline before embedding", async () => {
    const { repository, embed, input, save, now } = fixture();
    await expect(
      save({ ...input, batchExpiresAt: new Date(now()).toISOString() }),
    ).rejects.toThrow("learning_batch_expired");
    await expect(save({ ...input, batchExpiresAt: "invalid" })).rejects.toThrow(
      "invalid_learning_batch_expiry",
    );
    expect(embed).not.toHaveBeenCalled();
    expect((await repository.read()).revision).toBe(0);
  });

  it("does not commit embeddings that finish after the fixed replay deadline", async () => {
    const { repository, embed, save, advance } = fixture();
    embed.mockImplementation(async ({ texts }) => {
      advance(60_000);
      return {
        modelFingerprint: "test",
        dimensions: 2,
        vectors: texts.map(() => [1, 0]),
      };
    });
    await expect(save()).rejects.toThrow("learning_batch_expired");
    expect((await repository.read()).records).toEqual([]);
    expect((await repository.read()).observationReceipts).toBeUndefined();
  });
});
