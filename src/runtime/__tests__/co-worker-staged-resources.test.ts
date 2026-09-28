import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";
import { createRuntimePassiveLearningModel } from "../passive-learning/model.js";
import { CoWorkerResourceBudget } from "../passive-learning/resources/budget.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS } from "../passive-learning/resources/contracts.js";
import { createCoWorkerResourceGateway } from "../passive-learning/resources/gateway.js";
import type { LearningReviewInput } from "../passive-learning/review-references.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { CoWorkerReviewProgress, ReviewProgressPort } from "../passive-learning/review-progress.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => { vi.useRealTimers(); await disposeCompositionFixtures(); resetDebugLoggerConfig(); });
const NOW = Date.now();
const discovery = { decisions: [{ ref: "d1", evidence: ["o1"],
  objective: "A possible continuing interest in birdwatching." }] };
const authored = { decisions: [{ ref: "d1", content: "Possibly interested in birdwatching.", tags: [],
  reason: "Active research." }] };
const assessment = { decisions: [{ ref: "d1", score: 40, certainty: "inferred" }] };
const timing = { decisions: [{ ref: "d1", reconsiderAfterMinutes: null }] };
const response = (value: unknown) => ({ text: JSON.stringify(value), meta: { providerCompletionReason: "stop" } });

async function fixture(limit = 24, timeoutMs = 5000) {
  const base = await createRuntimeConfig();
  await writeFile(base.requestRunner.configPath, JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "learning", steps: {} } },
    context: { outputReserveTokens: 400, safetyReserveTokens: 50, attachmentReserveTokens: 1 },
    stepDefaults: { timeoutMs }, steps: {} }));
  const config: RuntimeConfig = { ...base, models: { defaults: { profileId: "learning" },
    providers: { local: { type: "ollama" } }, profiles: { learning: {
      provider: "local", model: "scripted", contextWindowTokens: 16000 } } } };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  let modelCallLimit = limit;
  const budget = new CoWorkerResourceBudget({ directory: base.paths.runtimeDir, now: () => NOW,
    limits: () => ({ ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, modelCallsPerDay: modelCallLimit }) });
  let allowed = true;
  const gateway = createCoWorkerResourceGateway({ gateway: { invoke, invokeRaw: vi.fn() }, budget,
    activity: "processing", supportsParallel: () => false, assertActivityAllowed() {
      if (!allowed) throw new Error("learning_outside_processing_window");
    } });
  const input: LearningReviewInput = { batchId: "resource-review", modelProfileId: "learning", promotionScore: 90,
    signal: new AbortController().signal, context: { kind: "learning_knowledge_reference_v1",
      authority: "passive_reference", presenceEffect: "does_not_authorize_actions_or_add_user_intent",
      entries: [], omitted: 0, referenceTime: new Date(NOW).toISOString(), repositoryRevision: 0, knowledgeRevision: 0 },
    observations: [{ id: "source", deviceId: "device", sequence: 1, timestamp: new Date(NOW).toISOString(),
      source: { app: "browser", windowId: "window" }, content: "Researching birdwatching equipment.",
      kind: "view", extraction: "uia", coverage: "partial" }] };
  const model = createRuntimePassiveLearningModel({ config, models: gateway });
  return { config, invoke, budget, input, model, closeWindow: () => { allowed = false; },
    setLimit: (value: number) => { modelCallLimit = value; } };
}

describe("staged Co-worker resource boundaries", () => {
  it("counts every small stage in the same daily budget and releases all slots", async () => {
    const f = await fixture();
    for (const output of [discovery, authored, assessment, timing]) f.invoke.mockResolvedValueOnce(response(output));
    await expect(f.model.review!(f.input)).resolves.toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledTimes(4);
    expect(await f.budget.status()).toMatchObject({ modelCalls: 4, activeCalls: 0 });
  });

  it("rejects a second call when only one daily call remains, without a partial result or refund", async () => {
    const f = await fixture(1);
    f.invoke.mockResolvedValueOnce(response(discovery));
    await expect(f.model.review!(f.input)).rejects.toThrow("co_worker_model_daily_budget_exhausted");
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(await f.budget.status()).toMatchObject({ modelCalls: 1, activeCalls: 0 });
  });

  it("does not dispatch authoring after the processing window closes", async () => {
    const f = await fixture();
    f.invoke.mockImplementationOnce(async () => { f.closeWindow(); return response(discovery); });
    await expect(f.model.review!(f.input)).rejects.toThrow("learning_outside_processing_window");
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(await f.budget.status()).toMatchObject({ modelCalls: 1, activeCalls: 0 });
  });

  it("gives each stage its configured deadline and releases a timed-out call", async () => {
    const f = await fixture(24, 1000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let authoringStarted!: () => void;
    const authoredStarted = new Promise<void>(resolve => { authoringStarted = resolve; });
    let authoredSignal: AbortSignal | undefined;
    f.invoke.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(700);
      return response(discovery);
    }).mockImplementationOnce(async ({ abortSignal }) => {
      authoredSignal = abortSignal;
      authoringStarted();
      return new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }));
    });
    const pending = f.model.review!(f.input);
    const rejected = expect(pending).rejects.toThrow("learning_batch_timeout");
    await authoredStarted;
    expect(authoredSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(authoredSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(700);
    await rejected;
    expect(authoredSignal?.aborted).toBe(true);
    expect(await f.budget.status()).toMatchObject({ modelCalls: 2, activeCalls: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a finite sequence to outlast one stage's deadline without extending individual calls", async () => {
    const f = await fixture(24, 1000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(NOW);
    for (const output of [discovery, authored, assessment, timing]) f.invoke.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(700); return response(output);
    });
    await expect(f.model.review!(f.input)).resolves.toHaveLength(1);
    expect(Date.now() - NOW).toBe(2800);
    expect(await f.budget.status()).toMatchObject({ modelCalls: 4, activeCalls: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes durable stages after quota deferral without charging for their replay", async () => {
    const f = await fixture(2); let saved: CoWorkerReviewProgress | undefined;
    const progress: ReviewProgressPort = { read: () => saved, save: async (next) => { saved = next; } };
    f.invoke.mockResolvedValueOnce(response(discovery)).mockResolvedValueOnce(response(authored));
    await expect(f.model.review!({ ...f.input, progress })).rejects.toThrow("co_worker_model_daily_budget_exhausted");
    expect(saved!.stages).toHaveLength(2);
    expect(await f.budget.status()).toMatchObject({ modelCalls: 2, activeCalls: 0 });
    f.setLimit(24);
    f.invoke.mockResolvedValueOnce(response(assessment)).mockResolvedValueOnce(response(timing));
    await expect(f.model.review!({ ...f.input, progress })).resolves.toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledTimes(4);
    expect(await f.budget.status()).toMatchObject({ modelCalls: 4, activeCalls: 0 });
  });

  it("keeps paid stages after an explicit pause and does not recharge them on resume", async () => {
    const f = await fixture(); const controller = new AbortController(); let saved: CoWorkerReviewProgress | undefined;
    const progress: ReviewProgressPort = { read: () => saved, save: async (next) => {
      saved = next; controller.abort(new Error("learning_processing_paused"));
    } };
    f.invoke.mockResolvedValueOnce(response(discovery));
    await expect(f.model.review!({ ...f.input, progress, signal: controller.signal })).rejects.toThrow("learning_processing_paused");
    expect(saved!.stages).toHaveLength(1);
    const resumed: ReviewProgressPort = { read: () => saved, save: async (next) => { saved = next; } };
    for (const output of [authored, assessment, timing]) f.invoke.mockResolvedValueOnce(response(output));
    await expect(f.model.review!({ ...f.input, progress: resumed })).resolves.toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledTimes(4);
    expect(await f.budget.status()).toMatchObject({ modelCalls: 4, activeCalls: 0 });
  });
});
