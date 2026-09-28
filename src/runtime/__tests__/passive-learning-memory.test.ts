import { describe, expect, it, vi } from "vitest";
import type { LongTermMemoryEmbeddingClient } from "../long-term-memory/contracts.js";
import { saveObservationMemoryBatch } from "../long-term-memory/observation-persistence.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { parseMemorySnapshot } from "../long-term-memory/repository-state.js";
import type { SaveObservationMemoryInput } from "../long-term-memory/observation-contracts.js";
import { createLearningMemoryService } from "../long-term-memory/maturation/service.js";

function fixture() {
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn<LongTermMemoryEmbeddingClient["embed"]>(async ({ texts }) => ({
    modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
  }));
  const memory = createLongTermMemoryService({
    repository,
    enabled: true,
    emitClientEvents: false,
    embeddings: { embed },
  });
  const input: SaveObservationMemoryInput = {
    batchId: "batch-1",
    batchExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    environmentId: "environment",
    abortSignal: new AbortController().signal,
    observations: [
      {
        id: "observation",
        deviceId: "device",
        timestamp: "2026-09-23T00:00:00Z",
      },
    ],
    proposals: [
      {
        content: "Uses an editor for TypeScript projects.",
        tags: ["workflow"],
        observationIds: ["observation"],
        reason: "Observed project context",
        certainty: "observed",
      },
    ],
  };
  return { memory, repository, input, embed };
}

describe("observed memory persistence", () => {
  it("keeps legacy observations as unscored candidates and reuses their embedding", async () => {
    const f = fixture();
    const original = await f.memory.saveObservationBatch!(f.input);
    f.embed.mockClear().mockRejectedValue(new Error("provider unavailable"));
    const merged = await f.memory.saveObservationBatch!({ ...f.input, batchId: "batch-2" });
    expect(merged.recordIds).toEqual(original.recordIds);
    expect(merged.recordIds).toEqual([]);
    expect(merged.candidateIds).toEqual(original.candidateIds);
    expect((await f.repository.read()).learningCandidates).toMatchObject([{ score: 0, reinforcements: [] }]);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("cannot promote a previously assessed candidate through legacy proposals", async () => {
    const { memory, repository, input } = fixture();
    await memory.saveObservationBatch!(input);
    const reinforcements = [0, 12, 24].map((hour, index) => ({
      key: String(index + 1).repeat(64),
      observedAt: new Date(Date.parse("2026-09-23T00:00:00Z") + hour * 3_600_000).toISOString(),
    }));
    await repository.update((current) => ({ ...current,
      learningCandidates: current.learningCandidates!.map((candidate) => ({ ...candidate, score: 95, reinforcements })),
    }));
    const receipt = await memory.saveObservationBatch!({ ...input, batchId: "unassessed-followup" });
    expect(receipt.recordIds).toEqual([]);
    expect(receipt.candidateIds).toHaveLength(1);
    expect((await repository.read()).learningCandidates).toMatchObject([{ score: 95, reinforcements }]);
  });

  it("does not revive a candidate deleted before commit", async () => {
    const f = fixture();
    const original = await f.memory.saveObservationBatch!(f.input);
    f.embed.mockClear();
    const input = { ...f.input, batchId: "batch-2", proposals: [f.input.proposals[0]!,
      { ...f.input.proposals[0]!, content: "Uses a separate research workspace." }] };
    const repository = { ...f.repository, update: async (mutate: Parameters<typeof f.repository.update>[0]) => {
      await f.repository.update((current) => ({ ...current, learningCandidates: [] }));
      return f.repository.update(mutate);
    } };
    const learning = createLearningMemoryService({ repository, embeddings: { embed: f.embed } });
    await expect(saveObservationMemoryBatch({ repository, learning, input })).rejects.toThrow("learning_decision_target_unknown");
    expect(f.embed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ texts: [input.proposals[1]!.content] }));
    expect(original.candidateIds).toHaveLength(1);
    expect((await repository.read()).records).toEqual([]);
    expect((await repository.read()).learningCandidates).toEqual([]);
  });
  it.each(["password=private-value", "x".repeat(4_001)])("rejects unsafe or oversized provenance reasons before saving", async (reason) => {
    const { memory, repository, input } = fixture();
    const receipt = await memory.saveObservationBatch!({
      ...input, proposals: [{ ...input.proposals[0]!, reason }],
    });
    expect(receipt.recordIds).toEqual([]);
    expect((await repository.read()).records).toEqual([]);
    expect(JSON.stringify(await repository.read())).not.toContain(reason);
  });

  it("preserves original observation alongside later duplicate candidate sources", async () => {
    const { memory, repository, input } = fixture();
    await memory.saveObservationBatch!(input);
    expect((await repository.read()).learningCandidates?.[0]?.sources)
      .toMatchObject([{ batchId: "batch-1" }]);
    await memory.saveObservationBatch!({ ...input, batchId: "batch-2" });
    expect((await repository.read()).learningCandidates?.[0]?.sources)
      .toMatchObject([{ batchId: "batch-1" }, { batchId: "batch-2" }]);
  });
  it("commits provenance and receipt atomically and replays after deletion without resurrection", async () => {
    const { memory, repository, input } = fixture();
    const receipt = await memory.saveObservationBatch!(input);
    const snapshot = await repository.read();
    expect(snapshot.schemaVersion).toBe(5);
    expect(parseMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(
      snapshot,
    );
    expect(snapshot.learningCandidates?.[0]?.sources[0]).toMatchObject({
      kind: "passive_observation",
      batchId: input.batchId,
      observationIds: ["observation"],
      certainty: "observed",
    });
    await repository.update((current) => ({ ...current, learningCandidates: [] }));
    expect(await memory.saveObservationBatch!(input)).toEqual(receipt);
    expect((await memory.list()).total).toBe(0);
    expect((await memory.learning!.list()).length).toBe(0);
  });
  it("leaves a duplicate manual record protected and outside observation results", async () => {
    const { memory, input } = fixture();
    const context = { abortSignal: input.abortSignal };
    const existing = await memory.create({
      content: input.proposals[0]!.content,
      tags: [],
      source: "web_ui",
      context,
    });
    await memory.create({
      content: "An unrelated manual preference.",
      tags: [],
      source: "web_ui",
      context,
    });
    const receipt = await memory.saveObservationBatch!(input);
    expect(receipt.recordIds).toEqual([]);
    const page = await memory.list({ origin: "passive_observation", limit: 1 });
    expect(page).toEqual({ total: 0, items: [] });
    const all = await memory.list();
    expect(all.items.find((record) => record.id === existing.record.id))
      .toEqual(existing.record);
  });
  it("rejects an unknown evidence reference before writing", async () => {
    const { memory, repository, input } = fixture();
    await expect(
      memory.saveObservationBatch!({
        ...input,
        proposals: [{ ...input.proposals[0]!, observationIds: ["missing"] }],
      }),
    ).rejects.toThrow("learning_proposal_source_unknown");
    expect((await repository.read()).revision).toBe(0);
  });
  it("keeps existing v1 memory snapshots readable", () => {
    expect(
      parseMemorySnapshot({
        schemaVersion: 1,
        revision: 0,
        records: [],
        vectors: [],
      }).schemaVersion,
    ).toBe(1);
  });
  it("honors a legacy replay receipt after its stored memory was deleted", async () => {
    const { memory, repository, input, embed } = fixture();
    const legacy = { batchId: input.batchId, recordIds: ["deleted"], createdAt: new Date().toISOString(), expiresAt: input.batchExpiresAt };
    await repository.update((current) => ({ ...current, observationReceipts: [legacy] }));
    expect(await memory.saveObservationBatch!(input)).toEqual(legacy);
    expect(embed).not.toHaveBeenCalled();
    expect((await repository.read()).learningCandidates ?? []).toEqual([]);
  });
  it("does not save a late embedding after cancellation", async () => {
    const { repository, input } = fixture();
    const controller = new AbortController();
    const memory = createLongTermMemoryService({
      repository,
      enabled: true,
      emitClientEvents: false,
      embeddings: {
        async embed({ texts }) {
          controller.abort();
          return {
            modelFingerprint: "test",
            dimensions: 2,
            vectors: texts.map(() => [1, 0]),
          };
        },
      },
    });
    await expect(
      memory.saveObservationBatch!({
        ...input,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
    expect((await repository.read()).records).toEqual([]);
  });
});
