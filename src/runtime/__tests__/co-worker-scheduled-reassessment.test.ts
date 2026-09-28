import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ScheduledLearningReassessment } from "../passive-learning/scheduled-reassessment.js";
import { DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS } from "../passive-learning/resources/contracts.js";
import type { LearningKnowledgeContext, LearningKnowledgeEntry, LearningMemoryDecision, LearningMemoryService, LearningReviewAdmission } from "../long-term-memory/maturation/contracts.js";
import type { PassiveLearningModel, PassiveLearningPreferences } from "../passive-learning/contracts.js";
import { buildLearningReviewMessages } from "../passive-learning/memory-review-format.js";
import { createLearningReviewPresentation, type LearningReviewInput } from "../passive-learning/review-references.js";
import { createLearningReviewFormat } from "../passive-learning/review-response-format.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { createReassessmentStateStore, learningReassessmentFingerprint } from "../passive-learning/reassessment-state.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

async function fixture() {
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-reassessment-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "fixture-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let preferences: PassiveLearningPreferences = { ...DEFAULT_LEARNING_PREFERENCES, enabled: false, processingPaused: false,
    modelProfileId: "learning", analysisIntervalMinutes: 1, proactiveEnabled: false };
  let due: string | null = new Date(NOW).toISOString();
  let busy = false;
  let queued = false;
  let admission: LearningReviewAdmission = { available: true, retryAt: null };
  let calls = 0;
  let version = "1";
  let extra: readonly LearningKnowledgeEntry[] = [];
  const context = (): LearningKnowledgeContext => ({ kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1, knowledgeRevision: 1,
    referenceTime: new Date().toISOString(), omitted: 0, entries: [...(due ? [{ kind: "candidate" as const, id: "candidate", version,
      content: "An upcoming plan whose date needs reassessment", tags: [], score: 60, reason: "Observed plan",
      certainty: "inferred" as const, mutable: true, lastReinforcedAt: new Date(NOW).toISOString(), reconsiderAt: due }] : []), ...extra] });
  const review = vi.fn<NonNullable<PassiveLearningModel["review"]>>(async () => []);
  const apply = vi.fn<LearningMemoryService["apply"]>(async (input) => {
    if (input.context.entries.some(({ id }) => id === "candidate")) due = null;
    extra = extra.filter((entry) => !input.context.entries.some(({ id }) => id === entry.id));
    return { batchId: input.batchId, recordIds: [], candidateIds: [], removedCandidateCount: 0,
      createdAt: new Date().toISOString(), expiresAt: input.batchExpiresAt };
  });
  const available = (input?: { exclude?: readonly Pick<LearningKnowledgeEntry, "kind" | "id" | "version">[] }) =>
    context().entries.filter((entry) => !input?.exclude?.some((item) => item.kind === entry.kind && item.id === entry.id && item.version === entry.version));
  const memory = { policy: async () => DEFAULT_MATURATION_POLICY,
    nextReconsiderationAt: async (input?: Parameters<typeof available>[0]) =>
      available(input).map(({ reconsiderAt }) => reconsiderAt!).sort()[0] ?? null,
    reconsiderationContext: async (input?: Parameters<typeof available>[0]) => ({ ...context(),
      entries: available(input).filter(({ reconsiderAt }) => Date.parse(reconsiderAt!) <= Date.now()) }),
    reviewAdmission: async () => admission, receipt: async () => undefined, apply } as unknown as LearningMemoryService;
  const changed = vi.fn();
  const resourceUsage = vi.fn(async () => ({ schemaVersion: 1 as const, timeZone: "UTC", startedAt: NOW, resetsAt: NOW + 3_600_000,
    modelCalls: calls, embeddingCalls: 0, embeddingCharacters: 0, activeCalls: 0 }));
  const build = () => {
    const runner = new ScheduledLearningReassessment({ directory, environmentId: "dev", memory,
      model: { review, validateProfile() {}, extract: async () => [] },
      context: { preferences: () => preferences, changed, isStarted: () => true, isInteractiveBusy: () => busy,
        isProcessingBusy: () => queued, assertProcessingAllowed() {} },
      resourceUsage });
    cleanup.unshift(() => runner.stop()); return runner;
  };
  const runner = build();
  return { directory, runner, build, context, review, apply, memory, resourceUsage, changed,
    setDue: (next: string | null) => { due = next; }, setVersion: (next: string) => { version = next; },
    setExtra: (entries: readonly LearningKnowledgeEntry[]) => { extra = entries; },
    setAdmission: (next: LearningReviewAdmission) => { admission = next; }, setCalls: (next: number) => { calls = next; },
    setBusy: (next: boolean) => { busy = next; }, setQueued: (next: boolean) => { queued = next; },
    update: async (next: Partial<PassiveLearningPreferences>) => { preferences = { ...preferences, ...next }; await runner.preferencesChanged(); } };
}
async function tick(runner: ScheduledLearningReassessment, milliseconds = 60_001) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await vi.waitFor(() => expect(runner.status().state).not.toBe("reviewing"));
}

describe("scheduled knowledge reassessment", () => {
  test("releases expired resumed progress and retries fresh at the normal interval", async () => {
    const f = await fixture(); const store = createReassessmentStateStore(f.directory);
    const fingerprint = learningReassessmentFingerprint(f.context());
    const entries = f.context().entries.map(({ kind, id, version }) => ({ kind, id, version }));
    const expiresAt = new Date(NOW + 61_000).toISOString();
    const savedProgress = { schemaVersion: 1 as const, method: "super-v2" as const, binding: "a".repeat(64),
      referenceTime: new Date(NOW + 61_000 - 86_400_000).toISOString(), expiresAt,
      stages: [{ key: "change", fingerprint: "b".repeat(64), response: '{"decisions":[]}',
        acceptedAt: new Date(NOW - 60_000).toISOString() }] };
    await store.reserve(fingerprint, entries, NOW - 60_000, () => {});
    await store.saveProgress(fingerprint, entries, savedProgress);
    let rejectReview!: (error: Error) => void;
    f.review.mockImplementationOnce(async (input) => {
      expect(input.progress!.read()).toEqual(savedProgress);
      expect(input.expiresAt).toBe(expiresAt);
      return new Promise((_, reject) => { rejectReview = reject; });
    }).mockImplementationOnce(async (input) => {
      expect(input.progress!.read()).toBeUndefined();
      expect(Date.parse(input.expiresAt!)).toBeGreaterThan(Date.now());
      return [];
    });
    await f.runner.start(); await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1000);
    expect(Date.now()).toBeGreaterThan(Date.parse(expiresAt));
    rejectReview(new Error("learning_review_progress_expired"));
    await vi.waitFor(() => expect(f.runner.status().state).not.toBe("reviewing"));
    expect(f.apply).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const state = await store.read();
      expect(state.blockedEntries).toEqual([]); expect(state.reviewProgress).toBeUndefined();
      expect(f.runner.status().nextReviewAt).toBeDefined();
    });
    const nextReviewAt = Date.parse(f.runner.status().nextReviewAt!);
    expect(nextReviewAt).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(nextReviewAt - Date.now() - 1);
    expect(f.review).toHaveBeenCalledOnce();
    await tick(f.runner, 2);
    expect(f.review).toHaveBeenCalledTimes(2); expect(f.apply).toHaveBeenCalledOnce();
    expect(f.runner.status().reason).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  test("a temporary memory outage does not permanently block scheduled knowledge review", async () => {
    const f = await fixture();
    f.review.mockRejectedValueOnce(new Error("learning_memory_unavailable"));
    await f.runner.start(); await tick(f.runner);
    expect(f.review).toHaveBeenCalledOnce(); expect(f.apply).not.toHaveBeenCalled();
    expect((await createReassessmentStateStore(f.directory).read()).blockedEntries).toEqual([]);
    await tick(f.runner);
    expect(f.review).toHaveBeenCalledTimes(2); expect(f.apply).toHaveBeenCalledOnce();
    expect(f.runner.status().reason).toBeUndefined();
  });

  test.each(["profile", "resume"])("preserves explicit %s retry after a transient retry-state failure", async (change) => {
    const f = await fixture();
    f.review.mockRejectedValueOnce(new Error("learning_decisions_invalid"));
    await f.runner.start(); await tick(f.runner);
    expect(f.review).toHaveBeenCalledOnce();
    if (change === "resume") await f.update({ processingPaused: true });
    const file = join(f.directory, "knowledge-reassessment.json");
    const saved = await readFile(file, "utf8");
    await writeFile(file, "{invalid");
    const update = change === "profile" ? { modelProfileId: "replacement" } : { processingPaused: false };
    await expect(f.update(update)).resolves.toBeUndefined();
    expect(f.runner.status().state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
    await writeFile(file, saved);
    await tick(f.runner, 120_000);
    expect(f.review).toHaveBeenCalledOnce();
    await f.update(update);
    expect((await createReassessmentStateStore(f.directory).read()).blockedEntries).toEqual([]);
    await tick(f.runner);
    expect(f.review).toHaveBeenCalledTimes(2);
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.runner.status().reason).toBeUndefined();
  });

  test("receipt recovery retains a different failed current binding", async () => {
    const f = await fixture(); const blocked = f.context().entries[0]!;
    const store = createReassessmentStateStore(f.directory);
    const failedFingerprint = "a".repeat(64), committedFingerprint = "b".repeat(64);
    await store.reserve(failedFingerprint, [blocked], NOW, () => {});
    await store.failed(failedFingerprint, [blocked], "learning_decisions_invalid", false);
    await store.reserve(committedFingerprint, [{ ...blocked, id: "completed" }], NOW, () => {});
    Object.assign(f.memory, {
      receipt: async (batchId: string) => batchId === `reassess-${committedFingerprint}` ? { batchId } : undefined,
      sourceVersions: async () => [blocked],
    });
    await f.runner.start(); await tick(f.runner);
    expect(await store.read()).toMatchObject({ fingerprint: null,
      blockedEntries: [{ kind: blocked.kind, id: blocked.id, version: blocked.version }] });
    expect(f.review).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("reviews due knowledge on the processing axis without recordings or proactive mode", async () => {
    const f = await fixture();
    Object.assign(f.memory, { policy: async () => ({ ...DEFAULT_MATURATION_POLICY, promotionScore: 95 }) });
    await f.runner.start(); await tick(f.runner);
    expect(f.review).toHaveBeenCalledOnce(); expect(f.apply).toHaveBeenCalledOnce();
    expect(f.review.mock.calls[0]![0]).toMatchObject({ modelProfileId: "learning", observations: [], promotionScore: 95,
      cause: { kind: "scheduled_knowledge_review", dueEntries: [{ kind: "candidate", id: "candidate", version: "1" }] } });
    expect(f.apply.mock.calls[0]![0]).toMatchObject({ observations: [], decisions: [], policy: { promotionScore: 95 }, cause: { kind: "scheduled_knowledge_review" } });
    const file = join(f.directory, "knowledge-reassessment.json");
    const modified = (await stat(file)).mtimeMs;
    await tick(f.runner, 86_400_000);
    expect(f.review).toHaveBeenCalledOnce(); expect((await stat(file)).mtimeMs).toBe(modified);
    expect(Buffer.byteLength(await readFile(file, "utf8"))).toBeLessThan(2048);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("waits for due dates, processing windows and exhausted shared quotas", async () => {
    const f = await fixture();
    f.setDue("2026-09-25T12:30:00Z"); f.setCalls(DEFAULT_CO_WORKER_RESOURCE_LIMITS.modelCallsPerDay);
    await f.update({ analysisWindow: { start: "14:00", end: "18:00", timeZone: "UTC" } });
    await f.runner.start();
    expect(f.runner.status().nextReviewAt).toBe("2026-09-25T14:00:00.000Z");
    await tick(f.runner, 60 * 60_000); expect(f.review).not.toHaveBeenCalled();
    f.setCalls(0); await tick(f.runner, 60 * 60_000);
    expect(f.review).toHaveBeenCalledOnce();
  });

  test("foreground and queued observations take priority without polling", async () => {
    const f = await fixture(); f.setQueued(true); await f.runner.start();
    expect(vi.getTimerCount()).toBe(0); await tick(f.runner, 5 * 60_000); expect(f.review).not.toHaveBeenCalled();
    f.setQueued(false); f.setBusy(true); f.runner.knowledgeChanged();
    await tick(f.runner); expect(f.review).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    f.setBusy(false); f.runner.knowledgeChanged();
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledOnce());
  });

  test("collection toggle preserves active processing while explicit processing pause rejects late output", async () => {
    const f = await fixture(); let finish!: (value: readonly LearningMemoryDecision[]) => void;
    f.review.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await f.runner.start(); await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledOnce());
    const signal = f.review.mock.calls[0]![0].signal;
    await f.update({ enabled: true, proactiveEnabled: true }); expect(signal.aborted).toBe(false);
    const pausing = f.update({ processingPaused: true });
    expect(signal.aborted).toBe(true); finish([]); await pausing;
    expect(f.apply).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    await f.update({ processingPaused: false }); await tick(f.runner);
    expect(f.review).toHaveBeenCalledTimes(2); expect(f.apply).toHaveBeenCalledOnce();
  });

  test("re-arms due reassessment when an application exclusion removes queued priority", async () => {
    const f = await fixture(); f.setQueued(true); await f.runner.start();
    await tick(f.runner, 5 * 60_000);
    expect(f.review).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    f.setQueued(false);
    await f.update({ processingExcludedApplications: ["Editor"] });
    await tick(f.runner, 1);
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.review.mock.calls[0]![0].observations).toEqual([]);
    expect(f.apply).toHaveBeenCalledOnce();
  });

  test.each(["state", "memory", "resources"].flatMap((failure) =>
    ["applications", "interval", "window", "budget", "profile"].map((setting) => [failure, setting])))
  ("reports a %s re-arm failure without rejecting saved %s settings", async (failure, setting) => {
    const f = await fixture(); f.setQueued(true); await f.runner.start();
    f.setQueued(false);
    const error = new Error("private dependency failure");
    if (failure === "state") await writeFile(join(f.directory, "knowledge-reassessment.json"), "{invalid");
    if (failure === "memory") vi.spyOn(f.memory, "nextReconsiderationAt").mockRejectedValueOnce(error);
    if (failure === "resources") f.resourceUsage.mockRejectedValueOnce(error);
    const updates: Record<string, Partial<PassiveLearningPreferences>> = {
      applications: { processingExcludedApplications: ["Editor"] }, interval: { analysisIntervalMinutes: 2 },
      window: { analysisWindow: { start: "12:00", end: "14:00", timeZone: "UTC" } },
      budget: { resourceLimits: { ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, modelCallsPerDay: 25 } },
      profile: { modelProfileId: "replacement" },
    };
    await expect(f.update(updates[setting!]!)).resolves.toBeUndefined();
    expect(f.runner.status()).toMatchObject({ state: "failed", reason: expect.any(String) });
    expect(f.runner.status().reason).not.toContain("private");
    expect(f.changed).toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("remembers a failed identical review across restart without repeated paid retries", async () => {
    const f = await fixture(); f.review.mockRejectedValueOnce(new Error("learning_decisions_invalid"));
    await f.runner.start(); await tick(f.runner); expect(f.runner.status().reason).toBe("learning_decisions_invalid");
    await f.runner.stop(); const restarted = f.build(); await restarted.start(); await tick(restarted, 4 * 3_600_000);
    expect(f.review).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    f.setVersion("2"); restarted.knowledgeChanged();
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledTimes(2));
  });

  test("receipt capacity defers before inference or attempt writes", async () => {
    const f = await fixture();
    f.setAdmission({ available: false, reason: "learning_receipt_capacity", retryAt: "2026-09-25T13:00:00Z" });
    await f.runner.start(); await tick(f.runner, 30 * 60_000);
    expect(f.review).not.toHaveBeenCalled();
    await expect(readFile(join(f.directory, "knowledge-reassessment.json"))).rejects.toMatchObject({ code: "ENOENT" });
    f.setAdmission({ available: true, retryAt: null }); await tick(f.runner, 30 * 60_000);
    expect(f.review).toHaveBeenCalledOnce();
  });

  test("a failed due record preserves a different deadline through delayed rearming", async () => {
    const f = await fixture();
    f.setExtra([{ ...f.context().entries[0]!, id: "later", reconsiderAt: new Date(NOW + 120_000).toISOString() }]);
    f.review.mockRejectedValueOnce(new Error("learning_decisions_invalid"));
    const nextDeadline = f.memory.nextReconsiderationAt.bind(f.memory);
    let releaseRearm!: () => void;
    const rearmReleased = new Promise<void>((resolve) => { releaseRearm = resolve; });
    cleanup.unshift(async () => releaseRearm());
    const delayedRead = vi.fn(async (input: Parameters<typeof nextDeadline>[0]) => {
      await rearmReleased;
      return nextDeadline(input);
    });
    vi.spyOn(f.memory, "nextReconsiderationAt")
      .mockImplementationOnce(nextDeadline)
      .mockImplementationOnce(delayedRead);

    await f.runner.start(); await tick(f.runner);
    await vi.waitFor(() => expect(delayedRead).toHaveBeenCalledOnce());
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.runner.status().nextReviewAt).toBeUndefined();
    await tick(f.runner);
    expect(f.review).toHaveBeenCalledOnce();

    const scheduling = new Promise<number>((resolve) => {
      f.changed.mockImplementationOnce(() => {
        const nextReviewAt = f.runner.status().nextReviewAt;
        expect(nextReviewAt).toBeDefined();
        resolve(Date.parse(nextReviewAt!));
      });
    });
    releaseRearm();
    // Await publication without advancing fake time past the newly armed timer.
    const nextReviewAt = await scheduling;
    await vi.advanceTimersByTimeAsync(nextReviewAt - Date.now() + 1);
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.runner.status().state).not.toBe("reviewing"));
    expect(f.review.mock.calls[1]![0].context.entries.map(({ id }) => id)).toEqual(["later"]);
    await tick(f.runner, 86_400_000);
    expect(f.review).toHaveBeenCalledTimes(2);
    await f.update({ modelProfileId: "replacement" }); await tick(f.runner);
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledTimes(3));
  });

  test("projects an explicit passive scheduled cause with no fabricated observations", async () => {
    const f = await fixture();
    const context = f.context();
    const input: LearningReviewInput = { batchId: "scheduled", context, observations: [], promotionScore: 80,
      modelProfileId: "learning", signal: new AbortController().signal,
      cause: { kind: "scheduled_knowledge_review", dueEntries: context.entries.map(({ kind, id, version }) => ({ kind, id, version })) } };
    const presentation = createLearningReviewPresentation(input);
    const messages = buildLearningReviewMessages(input, presentation);
    expect(messages.every(({ role }) => role === "system")).toBe(true);
    expect(JSON.parse(String(messages[1]!.content))).toMatchObject({ kind: "learning_memory_assignment_v2",
      cause: "scheduled_knowledge_review", dueTargets: ["k1"] });
    expect(JSON.parse(String(messages[3]!.content))).toMatchObject({ kind: "passive_learning_evidence_v2",
      authority: "passive_reference", presenceEffect: "does_not_authorize_actions_or_add_user_intent", observations: [] });
    const format = createLearningReviewFormat(presentation.references);
    const removal = { action: "remove", target: "k1", reason: "No longer relevant" };
    expect(validateJsonSchemaValue(format, { decisions: [removal] })).toBeUndefined();
    for (const invalid of [{ action: "create" }, { action: "merge" }, { evidence: [] }, { reinforced: true }]) {
      expect(validateJsonSchemaValue(format, { decisions: [{ ...removal, ...invalid }] })).toBeDefined();
    }
  });
});
