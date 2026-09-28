import { describe, expect, it, vi } from "vitest";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningBatch } from "../passive-learning/contracts.js";
import { processLearningBatch } from "../passive-learning/process-batch.js";

function fixture(recordIds: string[] = []) {
  const timestamp = new Date().toISOString();
  const batch: LearningBatch = {
    id: "batch",
    generation: "generation",
    createdAt: timestamp,
    status: "pending",
    reason: "learning_interactive_preempted",
    recordIds: [],
    observations: [
      {
        id: "observation",
        deviceId: "device",
        timestamp,
        sequence: 1,
        source: { app: "editor", windowId: "one" },
        content: "Project notes",
        kind: "view",
        extraction: "uia",
        coverage: "complete",
      },
    ],
  };
  let latest = batch;
  const replace = vi.fn(async (value: LearningBatch) => {
    latest = value;
  });
  const extract = vi.fn(async () => []);
  const save = vi.fn(async () => ({
    batchId: batch.id,
    recordIds,
    createdAt: timestamp,
  }));
  const controller = new AbortController();
  const options = {
    batch,
    signal: controller.signal,
    modelProfileId: "model",
    model: { validateProfile() {}, extract },
    memory: { saveObservationBatch: save } as unknown as LongTermMemoryService,
    ownerId: "environment",
    isCurrent: () => true,
    timestamp: () => timestamp,
    replace,
    failed: vi.fn(),
  };
  return { options, replace, extract, save, controller, latest: () => latest };
}

describe("learning batch failure and resume transitions", () => {
  it("keeps an initial journal write failure pending without running the model", async () => {
    const run = fixture();
    run.replace.mockRejectedValueOnce(
      new Error("learning_storage_unavailable"),
    );
    await processLearningBatch(run.options);
    expect(run.latest()).toMatchObject({
      id: "batch",
      status: "pending",
      reason: "learning_storage_unavailable",
      observations: run.options.batch.observations,
    });
    expect(run.latest().completedAt).toBeUndefined();
    expect(run.extract).not.toHaveBeenCalled();
    expect(run.save).not.toHaveBeenCalled();

    await processLearningBatch({ ...run.options, batch: run.latest() });
    expect(run.extract).toHaveBeenCalledOnce();
    expect(run.save).toHaveBeenCalledOnce();
    expect(run.latest()).toMatchObject({ id: "batch", status: "discarded" });
    expect(run.latest().reason).toBeUndefined();
  });

  it("does not revive pending work deleted during a failed initial write", async () => {
    const run = fixture();
    run.replace.mockImplementationOnce(async () => {
      run.controller.abort(new Error("learning_pending_deleted"));
      throw new Error("learning_storage_unavailable");
    });
    await processLearningBatch({ ...run.options, isCurrent: () => false });
    expect(run.latest().status).toBe("cancelled");
    expect(run.extract).not.toHaveBeenCalled();
    expect(run.save).not.toHaveBeenCalled();
  });

  it("keeps ordinary model failures terminal", async () => {
    const run = fixture();
    run.extract.mockRejectedValueOnce(new Error("model_unavailable"));
    await processLearningBatch(run.options);
    expect(run.latest()).toMatchObject({
      status: "failed",
      reason: "learning_failed",
    });
    expect(run.latest().completedAt).toBeDefined();
    expect(run.save).not.toHaveBeenCalled();
  });

  it.each([{ recordIds: [] }, { recordIds: ["memory"] }])(
    "clears interruption metadata through a successful resume ($recordIds)",
    async ({ recordIds }) => {
      const run = fixture(recordIds);
      await processLearningBatch(run.options);
      expect(run.replace.mock.calls[0]?.[0]).toMatchObject({
        status: "processing",
        reason: undefined,
        completedAt: undefined,
      });
      expect(run.latest().status).toBe(
        recordIds.length ? "saved" : "discarded",
      );
      expect(run.latest().reason).toBeUndefined();
    },
  );
});
