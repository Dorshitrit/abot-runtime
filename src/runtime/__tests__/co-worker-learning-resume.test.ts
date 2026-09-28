import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimePassiveLearningModel } from "../passive-learning/model.js";
import type { CoWorkerReviewProgress, ReviewProgressPort } from "../passive-learning/review-progress.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { LEARNING_NOW as NOW, learningInput as input, learningFixture as fixture,
  learningIdea as idea, learningDraft as draft, learningAssessment as assessment, learningTiming as timing,
  learningOutput as output, enqueueLearningCreation } from "./support/co-worker-learning-fixture.js";

beforeEach(() => { configureDebugLogger({ enabled: false }); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(async () => { vi.useRealTimers(); await disposeCompositionFixtures(); resetDebugLoggerConfig(); });
function progressPort() {
  let value: CoWorkerReviewProgress | undefined;
  const save = vi.fn(async (next: CoWorkerReviewProgress | undefined) => { value = structuredClone(next); });
  const port: ReviewProgressPort = { read: () => value, save };
  return { port, save };
}

describe("SUPER learning checkpoint replay", () => {
  it("resumes completed stages after model reconstruction without repeating calls", async () => {
    const f = await fixture();
    const { port } = progressPort();
    const request = { ...input(), progress: port };
    f.invoke.mockResolvedValueOnce(output([idea])).mockResolvedValueOnce(output([draft]))
      .mockRejectedValueOnce(new Error("co_worker_model_daily_budget_exhausted"));
    await expect(f.model.review!(request)).rejects.toThrow("co_worker_model_daily_budget_exhausted");
    expect(port.read()?.stages.map(stage => stage.key)).toEqual(["discovery", "authoring"]);
    f.invoke.mockResolvedValueOnce(output([assessment])).mockResolvedValueOnce(output([timing]));
    const reconstructed = createRuntimePassiveLearningModel({ config: f.config, models: f.gateway });
    vi.setSystemTime(NOW + 60_000);
    await expect(reconstructed.review!({ ...request, context: { ...request.context,
      referenceTime: new Date(NOW + 60_000).toISOString(), repositoryRevision: 2, knowledgeRevision: 2 } })).resolves.toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledTimes(5);
    expect(port.read()?.stages).toHaveLength(4);
  });

  it("persists a completed stage before honouring pause and resumes it", async () => {
    const f = await fixture();
    const { port, save } = progressPort();
    const abort = new AbortController();
    const originalSave = save.getMockImplementation()!;
    save.mockImplementation(async next => {
      await originalSave(next);
      if (next?.stages.length === 1) abort.abort(new Error("learning_processing_paused"));
    });
    f.invoke.mockResolvedValueOnce(output([idea]));
    await expect(f.model.review!({ ...input(), progress: port, signal: abort.signal })).rejects.toThrow("learning_processing_paused");
    expect(port.read()?.stages).toHaveLength(1);
    for (const row of [draft, assessment, timing]) f.invoke.mockResolvedValueOnce(output([row]));
    await expect(f.model.review!({ ...input(), progress: port })).resolves.toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledTimes(4);
  });

  it.each(["source", "model", "knowledge"] as const)("invalidates saved work when its %s binding changes", async changed => {
    const f = await fixture();
    const { port } = progressPort();
    enqueueLearningCreation(f.invoke);
    await f.model.review!({ ...input(), progress: port });
    let request = { ...input(), progress: port };
    if (changed === "source") request = { ...request, observations: [{ ...request.observations[0]!, content: "A different activity." }] };
    if (changed === "knowledge") request = { ...request, context: { ...request.context, entries: [{
      kind: "candidate", id: "other", version: "1", content: "Changed knowledge", tags: [], score: 1,
      certainty: "inferred", reason: "", mutable: true, reconsiderAt: null, lastReinforcedAt: null,
    }] } };
    const config = changed === "model" ? { ...f.config, models: { ...f.config.models!, profiles: {
      learning: { ...f.config.models!.profiles!.learning!, model: "another-model" },
    } } } : f.config;
    const model = createRuntimePassiveLearningModel({ config, models: f.gateway });
    f.invoke.mockResolvedValueOnce(output([]));
    await expect(model.review!(request)).resolves.toEqual([]);
    expect(f.invoke).toHaveBeenCalledTimes(5);
    expect(port.read()?.stages.map(stage => stage.key)).toEqual(["discovery"]);
  });

  it("stops before another paid call when checkpoint storage fails", async () => {
    const f = await fixture();
    const port: ReviewProgressPort = { read: () => undefined, save: async () => { throw new Error("learning_review_progress_storage_unavailable"); } };
    f.invoke.mockResolvedValueOnce(output([idea]));
    await expect(f.model.review!({ ...input(), progress: port })).rejects.toThrow("learning_review_progress_storage_unavailable");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps original timing on replay and refreshes only a deadline that expired", async () => {
    const f = await fixture();
    const { port } = progressPort();
    for (const row of [idea, draft, assessment, { ...timing, reconsiderAfterMinutes: 2 }]) f.invoke.mockResolvedValueOnce(output([row]));
    const request = { ...input(), progress: port };
    const first = await f.model.review!(request);
    vi.setSystemTime(NOW + 60_000);
    const repeated = await f.model.review!(request);
    expect(repeated[0]!.reconsiderAt).toBe(first[0]!.reconsiderAt);
    expect(f.invoke).toHaveBeenCalledTimes(4);
    vi.setSystemTime(NOW + 180_000);
    f.invoke.mockResolvedValueOnce(output([timing]));
    await expect(f.model.review!(request)).resolves.toMatchObject([{ reconsiderAt: null }]);
    expect(f.invoke).toHaveBeenCalledTimes(5);
  });

  it("does not touch checkpoint storage for EA", async () => {
    const f = await fixture(true);
    const { port, save } = progressPort();
    f.invoke.mockResolvedValueOnce(output([]));
    await f.model.review!({ ...input(), progress: port });
    expect(save).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
});
