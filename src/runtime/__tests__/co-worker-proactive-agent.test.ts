import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoWorkerProactiveAgent } from "../passive-learning/proactive/agent.js";
import { createProactiveStateStore } from "../passive-learning/proactive/store.js";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { ensureSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { CoWorkerResourceBudget } from "../passive-learning/resources/budget.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS } from "../passive-learning/resources/contracts.js";
import type { LearningMemoryService, LearningKnowledgeContext } from "../long-term-memory/maturation/contracts.js";
import type { PassiveLearningPreferences } from "../passive-learning/contracts.js";
import type { ProactiveDecision, ProactiveReviewInput } from "../passive-learning/proactive/contracts.js";

const filesystemHooks = vi.hoisted(() => ({ afterRename: undefined as undefined | ((target: string) => Promise<void>) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await actual.rename(...args);
    await filesystemHooks.afterRename?.(String(args[1]));
  } };
});

const NOW = Date.parse("2026-09-25T12:00:00Z");
const roots: string[] = [];
const agents: CoWorkerProactiveAgent[] = [];
const reviewCompletion = new WeakMap<CoWorkerProactiveAgent, () => Promise<void>>();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(async () => {
  filesystemHooks.afterRename = undefined;
  for (const agent of agents.splice(0)) await agent.stop();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function knowledge(): LearningKnowledgeContext {
  return { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1, knowledgeRevision: 1,
    referenceTime: new Date(Date.now()).toISOString(), omitted: 0,
    entries: [{ kind: "candidate", id: "one", version: "1", content: "A possible ongoing interest", tags: [],
      score: 40, reason: "Tentative", certainty: "inferred", mutable: true, lastReinforcedAt: null, reconsiderAt: null }] };
}
function none(): ProactiveDecision {
  return { kind: "none", title: null, message: null, handoffBrief: null, reason: "Nothing useful", sources: [], expiresAt: null, reconsiderAt: null };
}
function proposal(): ProactiveDecision {
  return { kind: "proposal", title: "An idea", message: "Would you like me to look into this?", reason: "A possible interest",
    handoffBrief: "Background from SPARK: a possible ongoing interest suggests a focused review may help. The user's next request is pending.",
    sources: [{ kind: "candidate", id: "one", version: "1" }], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reconsiderAt: null };
}
async function fixture() {
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-proactive-agent-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-")); roots.push(root);
  let preferences: PassiveLearningPreferences = { enabled: false, processingPaused: true, excludedApplications: [], modelProfileId: "learning",
    proactiveEnabled: true, proactiveModelProfileId: "proactive", proactiveIntervalMinutes: 1,
    proactiveMessagesPerDay: 2, resourceLimits: DEFAULT_CO_WORKER_RESOURCE_LIMITS };
  let context = knowledge();
  let busy = false;
  let notifyChanged!: () => void;
  let nextChange = new Promise<void>((resolve) => { notifyChanged = resolve; });
  const changed = vi.fn().mockImplementation(() => {
    notifyChanged();
    nextChange = new Promise<void>((resolve) => { notifyChanged = resolve; });
  });
  const review = vi.fn<(input: ProactiveReviewInput) => Promise<ProactiveDecision>>(async () => none());
  const overview = vi.fn(async () => ({ ...context, referenceTime: new Date(Date.now()).toISOString() }));
  const memory = { overview, sourceVersions: async () => context.entries } as unknown as LearningMemoryService;
  const sessions = createFileSessionStore({ sessionsDir: join(root, "sessions") });
  const budget = new CoWorkerResourceBudget({ directory: root, limits: () => preferences.resourceLimits! });
  const build = () => {
    const agent = new CoWorkerProactiveAgent({ directory: root, memory, sessions, budget, model: { review, validateProfile() {} },
      context: { preferences: () => preferences, changed, assertProcessingAllowed() { throw new Error("processing_off"); },
        isInteractiveBusy: () => busy, isStarted: () => true } });
    reviewCompletion.set(agent, async () => {
      while (true) {
        // Capture before reading status so a concurrent completion cannot be missed.
        const changed = nextChange;
        const isReviewing = (await agent.status()).state === "reviewing";
        if (!isReviewing) return;
        await changed;
      }
    });
    agents.push(agent); return agent;
  };
  const agent = build();
  return { root, agent, build, review, changed, overview, sessions, budget,
    update: async (input: Partial<PassiveLearningPreferences>) => { preferences = { ...preferences, ...input }; await agent.preferencesChanged(); },
    knowledge: (input: LearningKnowledgeContext) => { context = input; agent.knowledgeChanged(); },
    busy: (value: boolean) => { busy = value; } };
}
async function tick(agent: CoWorkerProactiveAgent, milliseconds = 60_001) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  const waitForReviewCompletion = reviewCompletion.get(agent);
  if (!waitForReviewCompletion) throw new Error("proactive_test_agent_not_registered");
  await waitForReviewCompletion();
}
async function persistPending(root: string, reviewId: string, expiresAt = Date.now() + 86_400_000) {
  const store = createProactiveStateStore(root);
  const state = await store.read();
  const committed = await store.commitReview({ reviewId, expectedRevision: state.revision,
    knowledgeRevision: 1, decision: { ...proposal(), expiresAt: new Date(expiresAt).toISOString() }, now: Date.now() });
  return committed.proposals.at(-1)!;
}

describe("proactive background work", () => {
  test("a cleared delivery with a pending receipt settles without restoring or notifying the message", async () => {
    const h = await fixture(); const pending = await persistPending(h.root, "already-appended");
    await h.sessions.appendAssistantInitiative!(SPARK_SESSION_ID, {
      title: pending.title, content: pending.message,
      initiative: { kind: "proactive_proposal_v1", proposalId: pending.id, reason: pending.reason, sources: pending.sources },
    });
    await h.sessions.clearSessionMessages(SPARK_SESSION_ID);
    await h.agent.start(); await tick(h.agent, 1);
    expect((await h.sessions.getSessionById(SPARK_SESSION_ID))?.messages).toEqual([]);
    expect((await createProactiveStateStore(h.root).read()).proposals[0]?.status).toBe("delivered");
    expect(h.changed.mock.calls.some(([event]) => event?.type === "proposal_delivered")).toBe(false);
    expect(h.review).not.toHaveBeenCalled();
  });

  test("successive proposals append to the same conversation without changing review cadence", async () => {
    const h = await fixture();
    await ensureSparkSession(h.sessions);
    await h.sessions.appendMessage(SPARK_SESSION_ID, "user", "Hello SPARK");
    h.review.mockImplementation(async () => proposal());
    await h.agent.start(); await tick(h.agent);
    h.knowledge({ ...knowledge(), knowledgeRevision: 2 });
    await vi.waitFor(async () => expect((await h.agent.status()).nextReviewAt).toBeDefined());
    await tick(h.agent);
    expect(h.review).toHaveBeenCalledTimes(2);
    expect((await h.sessions.listSessions()).sessions).toMatchObject([{ id: SPARK_SESSION_ID, kind: "spark" }]);
    const messages = (await h.sessions.getSessionById(SPARK_SESSION_ID))!.messages;
    expect(messages.map(({ role }) => role)).toEqual(["user", "assistant", "assistant"]);
    for (const message of messages.slice(1)) expect(message.initiative).toMatchObject({
      handoffBrief: proposal().handoffBrief, handoffTitle: proposal().title, sources: proposal().sources,
    });
    expect(new Set(messages.map(({ id }) => id)).size).toBe(3);
    expect(h.changed.mock.calls.filter(([event]) => event?.type === "proposal_delivered")
      .map(([event]) => event.sessionId)).toEqual([SPARK_SESSION_ID, SPARK_SESSION_ID]);
  });

  test("an undelivered legacy proposal targets SPARK while historical sessions remain untouched", async () => {
    const h = await fixture();
    await persistPending(h.root, "pending-before-upgrade");
    const statePath = join(h.root, "proactive.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.proposals[0].sessionId = "co-worker-old-target";
    delete state.proposals[0].handoffBrief;
    await writeFile(statePath, JSON.stringify(state));
    const old = await h.sessions.appendMessage("legacy-history", "assistant", "An old proposal", { source: "co_worker" });
    await h.agent.start(); await tick(h.agent, 1);
    expect((await createProactiveStateStore(h.root).read()).proposals[0]).toMatchObject({
      sessionId: SPARK_SESSION_ID, status: "delivered" });
    expect((await h.sessions.getSessionById(SPARK_SESSION_ID))?.messages).toHaveLength(1);
    expect((await h.sessions.getSessionById(SPARK_SESSION_ID))?.messages[0]?.initiative).not.toHaveProperty("handoffBrief");
    expect(await h.sessions.getSessionById("co-worker-old-target")).toBeNull();
    expect(await h.sessions.getSessionById("legacy-history")).toEqual(old);
    expect(h.review).not.toHaveBeenCalled();
  });

  test("waits for filesystem completion without advancing the scheduler clock", async () => {
    const f = await fixture();
    let release!: () => void; let entered!: () => void; let inspected!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const inspecting = new Promise<void>((resolve) => { inspected = resolve; });
    filesystemHooks.afterRename = async (target) => {
      if (target !== join(f.root, "proactive.json")) return;
      entered(); await held;
    };
    await f.agent.start(); await vi.advanceTimersByTimeAsync(60_001);
    let completion: Promise<void> | undefined;
    try {
      await writing;
      const now = Date.now(); const status = f.agent.status.bind(f.agent);
      vi.spyOn(f.agent, "status").mockImplementationOnce(async () => {
        const result = await status(); inspected(); return result;
      });
      let settled = false;
      completion = tick(f.agent, 0).then(() => { settled = true; });
      await inspecting;
      expect(settled).toBe(false);
      expect(Date.now()).toBe(now);
      release(); await completion;
      expect((await f.agent.status()).state).not.toBe("reviewing");
      expect(f.review).toHaveBeenCalledOnce();
      expect(Date.now()).toBe(now);
    } finally { release(); await completion; }
  });

  test.each(["updated", "removed", "disabled"])("rolls back a conversation when %s during its filesystem commit", async (change) => {
    const f = await fixture(); const pending = await persistPending(f.root, "commit-race");
    const existing = await f.sessions.getOrCreateSession("unrelated");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let renamed = false;
    filesystemHooks.afterRename = async (target) => {
      if (target !== join(f.root, "sessions", `${pending.sessionId}.json`)) return;
      renamed = true; await held;
    };
    try {
      await f.agent.start(); await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(renamed).toBe(true));
      const disabling = change === "disabled" ? f.update({ proactiveEnabled: false }) : Promise.resolve();
      if (change !== "disabled") f.knowledge({ ...knowledge(), knowledgeRevision: 2,
        entries: change === "removed" ? [] : knowledge().entries.map((entry) => ({ ...entry, version: "2" })) });
      release(); await disabling;
      await vi.waitFor(async () => expect((await createProactiveStateStore(f.root).read()).proposals[0]?.status).toBe("cancelled"));
      expect(await f.sessions.getSessionById(pending.sessionId)).toBeNull();
      expect(await f.sessions.getSessionById(existing.id)).toEqual(existing);
      expect(f.changed.mock.calls.some(([event]) => event?.type === "proposal_delivered")).toBe(false);
      expect(f.review).not.toHaveBeenCalled();
    } finally { release(); }
  });

  test("raising the message cap releases an already pending proposal before the daily reset", async () => {
    const f = await fixture(); await f.update({ proactiveMessagesPerDay: 1 });
    const previous = await persistPending(f.root, "previous-delivery");
    let pending!: Awaited<ReturnType<typeof persistPending>>;
    f.overview.mockImplementationOnce(async () => {
      const usage = await f.budget.ensureCurrentWindow();
      await createProactiveStateStore(f.root).markDelivered(previous.id, Date.now(), usage.startedAt);
      pending = await persistPending(f.root, "pending-after-cap");
      return knowledge();
    });
    await f.agent.start();
    await tick(f.agent, 1);
    expect((await f.agent.status()).reason).toBe("proactive_daily_message_limit_reached");
    expect(await f.sessions.getSessionById(pending.sessionId)).toBeNull();
    await f.update({ proactiveMessagesPerDay: 2 }); await tick(f.agent, 1);
    await vi.waitFor(async () => expect((await f.sessions.getSessionById(pending.sessionId))?.messages).toHaveLength(1));
    expect(f.review).not.toHaveBeenCalled();
    expect((await f.agent.status()).deliveredToday).toBe(2);
  });

  test("raising the model budget rechecks admission without the old quota deadline", async () => {
    const f = await fixture(); await f.agent.start();
    for (let index = 0; index < 24; index++) {
      const release = await f.budget.reserve({ kind: "model", signal: new AbortController().signal,
        supportsParallel: false, assertActivityAllowed() {} }); release();
    }
    await tick(f.agent);
    expect(f.review).not.toHaveBeenCalled();
    expect((await f.agent.status()).reason).toBe("co_worker_model_daily_budget_exhausted");
    await f.update({ resourceLimits: { ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, modelCallsPerDay: 25 } });
    await tick(f.agent, 1);
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledOnce());
    expect((await f.budget.status()).modelCalls).toBe(24);
  });

  test.each(["before first review", "after a review", "after a retryable failure"].flatMap((phase) =>
    [[1, 5, phase], [5, 1, phase]] as const))
  ("reschedules %i to %i minutes %s", async (previous, next, phase) => {
    const f = await fixture(); await f.update({ proactiveIntervalMinutes: previous });
    if (phase === "after a retryable failure") f.review.mockRejectedValueOnce(new Error("co_worker_resources_busy"));
    await f.agent.start();
    if (phase !== "before first review") {
      await tick(f.agent, previous * 60_000 + 1);
      expect(f.review).toHaveBeenCalledOnce();
      f.knowledge({ ...knowledge(), knowledgeRevision: 2 });
      await vi.waitFor(async () => expect((await f.agent.status()).nextReviewAt).toBeDefined());
    }
    await tick(f.agent, 30_000);
    const calls = f.review.mock.calls.length;
    const due = Date.now() + next * 60_000;
    await f.update({ proactiveIntervalMinutes: next });
    expect((await f.agent.status()).nextReviewAt).toBe(new Date(due).toISOString());
    await vi.advanceTimersByTimeAsync(due - Date.now() - 1);
    expect(f.review).toHaveBeenCalledTimes(calls);
    await tick(f.agent, 2);
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledTimes(calls + 1));
  });

  test("changing the cadence does not delay an already pending proposal", async () => {
    const f = await fixture(); f.busy(true); await f.agent.start();
    const pending = await persistPending(f.root, "pending-cadence-change");
    f.busy(false); await f.update({ proactiveIntervalMinutes: 60 });
    await tick(f.agent, 1);
    await vi.waitFor(async () => expect((await f.sessions.getSessionById(pending.sessionId))?.messages).toHaveLength(1));
    expect(f.review).not.toHaveBeenCalled();
  });

  test.each(["store", "memory", "budget"])("isolates a %s scheduling failure after a settings change", async (failure) => {
    const f = await fixture(); await f.agent.start();
    const error = new Error("private dependency failure");
    if (failure === "store") await writeFile(join(f.root, "proactive.json"), "{invalid");
    if (failure === "memory") f.overview.mockRejectedValueOnce(error);
    if (failure === "budget") vi.spyOn(f.budget, "status").mockRejectedValueOnce(error);
    await expect(f.update({ proactiveIntervalMinutes: 2 })).resolves.toBeUndefined();
    if (failure === "store") await rm(join(f.root, "proactive.json"));
    expect(await f.agent.status()).toMatchObject({ state: "failed", reason: expect.any(String) });
    expect(JSON.stringify(await f.agent.status())).not.toContain("private");
    expect(f.changed).toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("works with recording and processing off, then stays asleep without changed knowledge", async () => {
    const h = await fixture(); await h.agent.start(); await vi.advanceTimersByTimeAsync(59_999);
    expect(h.review).not.toHaveBeenCalled();
    await tick(h.agent, 2);
    expect(h.review).toHaveBeenCalledTimes(1);
    expect(h.review.mock.calls[0]?.[0].modelProfileId).toBe("proactive");
    const file = join(h.root, "proactive.json"); const before = await readFile(file, "utf8");
    const modified = (await stat(file)).mtimeMs;
    await tick(h.agent, 12 * 3_600_000);
    await h.agent.status(); await h.agent.status();
    expect(h.review).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(modified);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("commits a proposal and one session before notifying, without repeating after restart", async () => {
    const h = await fixture(); h.review.mockImplementation(async () => proposal());
    await h.agent.start(); await tick(h.agent);
    const event = h.changed.mock.calls.find(([event]) => event?.type === "proposal_delivered")?.[0];
    expect(event?.sessionId).toBeTruthy();
    expect((await h.sessions.getSessionById(event.sessionId))?.messages).toHaveLength(1);
    expect((await createProactiveStateStore(h.root).read()).proposals[0]?.status).toBe("delivered");
    await h.agent.stop(); const restarted = h.build(); await restarted.start(); await tick(restarted, 4 * 3_600_000);
    expect(h.review).toHaveBeenCalledTimes(1);
    expect((await h.sessions.listSessions()).sessions).toHaveLength(1);
    expect(h.changed.mock.calls.filter(([event]) => event?.type === "proposal_delivered")).toHaveLength(1);
  });

  test("recovers an expiring paid proposal immediately while new reviews retain startup cadence", async () => {
    const h = await fixture(); await h.update({ proactiveIntervalMinutes: 60 });
    const pending = await persistPending(h.root, "saved-before-restart", NOW + 30_000);
    h.knowledge({ ...knowledge(), knowledgeRevision: 2 });
    const restarted = h.build(); await restarted.start(); await tick(restarted, 1);
    await vi.waitFor(async () => expect((await createProactiveStateStore(h.root).read()).proposals[0]?.status).toBe("delivered"));
    expect(Date.now()).toBeLessThan(Date.parse(pending.expiresAt));
    expect((await h.sessions.getSessionById(pending.sessionId))?.messages).toHaveLength(1);
    expect(h.review).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await restarted.status()).nextReviewAt).toBe(new Date(NOW + 3_600_000).toISOString()));
    await vi.advanceTimersByTimeAsync(NOW + 3_600_000 - Date.now() - 1);
    expect(h.review).not.toHaveBeenCalled();
    await tick(restarted, 2);
    expect(h.review).toHaveBeenCalledOnce();
    expect((await h.sessions.listSessions()).sessions).toHaveLength(1);
  });

  test("pending recovery remains disabled when proactive mode is off", async () => {
    const h = await fixture(); await h.update({ proactiveEnabled: false });
    await persistPending(h.root, "disabled-pending");
    await h.agent.start(); await tick(h.agent, 3_600_000);
    expect(h.review).not.toHaveBeenCalled();
    expect((await h.sessions.listSessions()).sessions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("pending recovery waits for its window without waiting for a new review", async () => {
    const h = await fixture(); await h.update({ proactiveIntervalMinutes: 60,
      proactiveWindow: { start: "12:30", end: "13:00", timeZone: "UTC" } });
    await persistPending(h.root, "window-pending");
    await h.agent.start(); await tick(h.agent, 29 * 60_000);
    expect((await h.sessions.listSessions()).sessions).toEqual([]);
    await tick(h.agent, 60_001);
    expect((await h.sessions.listSessions()).sessions).toHaveLength(1);
    expect(h.review).not.toHaveBeenCalled();
  });

  test("pending recovery cannot bypass the daily message cap", async () => {
    const h = await fixture(); await h.update({ proactiveMessagesPerDay: 1 });
    const delivered = await persistPending(h.root, "already-delivered");
    const usage = await h.budget.ensureCurrentWindow();
    await createProactiveStateStore(h.root).markDelivered(delivered.id, Date.now(), usage.startedAt);
    await persistPending(h.root, "capped-pending");
    await h.agent.start(); await tick(h.agent, 3_600_000);
    expect(h.review).not.toHaveBeenCalled();
    expect((await h.sessions.listSessions()).sessions).toEqual([]);
    expect((await h.agent.status()).reason).toBe("proactive_daily_message_limit_reached");
  });

  test("a recovered delivery failure retains retry backoff", async () => {
    const h = await fixture(); await persistPending(h.root, "delivery-retry");
    const delivery = vi.spyOn(h.sessions, "appendAssistantInitiative").mockRejectedValueOnce(new Error("proactive_session_delivery_unavailable"));
    await h.agent.start(); await tick(h.agent, 1);
    await vi.waitFor(async () => expect((await h.agent.status()).reason).toBe("proactive_session_delivery_unavailable"));
    const retryAt = Date.parse((await h.agent.status()).nextReviewAt!);
    expect(delivery).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(delivery).toHaveBeenCalledOnce();
    await tick(h.agent, 2);
    expect(delivery).toHaveBeenCalledTimes(2);
    expect((await h.sessions.listSessions()).sessions).toHaveLength(1);
    expect(h.review).not.toHaveBeenCalled();
  });

  test("a failed review sleeps across restart until knowledge changes or an explicit resume", async () => {
    const h = await fixture();
    h.review.mockRejectedValue(new Error("proactive_decision_invalid"));
    await h.agent.start(); await tick(h.agent);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    expect((await h.agent.status()).reason).toBe("proactive_decision_invalid");
    const file = join(h.root, "proactive.json");
    const failedState = await readFile(file, "utf8");
    await tick(h.agent, 8 * 3_600_000);
    expect(h.review).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe(failedState);

    h.knowledge({ ...knowledge(), knowledgeRevision: 2 });
    await vi.waitFor(() => expect(h.review).toHaveBeenCalledTimes(2));
    await tick(h.agent);
    expect(h.review).toHaveBeenCalledTimes(2);
    await h.agent.stop();
    const restarted = h.build(); await restarted.start(); await tick(restarted, 8 * 3_600_000);
    expect(h.review).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await restarted.stop();

    h.review.mockResolvedValue(none());
    await h.update({ proactiveEnabled: false });
    await h.update({ proactiveEnabled: true });
    await h.agent.start(); await tick(h.agent);
    expect(h.review).toHaveBeenCalledTimes(3);
    expect((await createProactiveStateStore(h.root).read()).reviewAttempt).toBeUndefined();
  });

  test("explicit off cancels a running review and rejects its late result", async () => {
    const h = await fixture(); let finish!: (decision: ProactiveDecision) => void;
    h.review.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await h.agent.start(); await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => expect(h.review).toHaveBeenCalledOnce());
    await h.update({ enabled: true, processingPaused: false });
    expect(h.review.mock.calls[0]?.[0].signal.aborted).toBe(false);
    const disabling = h.update({ proactiveEnabled: false });
    expect(h.review.mock.calls[0]?.[0].signal.aborted).toBe(true);
    finish(proposal()); await disabling;
    expect((await h.sessions.listSessions()).sessions).toEqual([]);
    expect((await createProactiveStateStore(h.root).read()).proposals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a window end settles the current review but delays delivery and rejects stale sources", async () => {
    const h = await fixture(); await h.update({ proactiveWindow: { start: "12:00", end: "12:02", timeZone: "UTC" } });
    let finish!: (decision: ProactiveDecision) => void;
    h.review.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await h.agent.start(); await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => expect(h.review).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(60_000); finish(proposal());
    await vi.waitFor(async () => expect((await h.agent.status()).state).toBe("waiting"));
    expect((await h.sessions.listSessions()).sessions).toEqual([]);
    expect((await createProactiveStateStore(h.root).read()).proposals[0]?.status).toBe("pending");
    h.knowledge({ ...knowledge(), entries: [], knowledgeRevision: 2 });
    await tick(h.agent, 24 * 3_600_000);
    expect((await h.sessions.listSessions()).sessions).toEqual([]);
    expect(h.review).toHaveBeenCalledTimes(1);
  });

  test("quota prevents model dispatch until reset, and empty knowledge never creates a timer", async () => {
    const h = await fixture();
    for (let index = 0; index < 24; index++) {
      const release = await h.budget.reserve({ kind: "model", signal: new AbortController().signal,
        supportsParallel: false, assertActivityAllowed() {} }); release();
    }
    await h.agent.start(); await tick(h.agent, 3_600_000);
    expect(h.review).not.toHaveBeenCalled();
    expect(Date.parse((await h.agent.status()).nextReviewAt!)).toBeGreaterThan(Date.now());
    h.knowledge({ ...knowledge(), entries: [], knowledgeRevision: 2 });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  test.each(["updated", "removed"])("rejects a delivery whose source is %s while session creation is waiting", async (change) => {
    const h = await fixture(); const pending = await persistPending(h.root, "pending-source-change");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const create = h.sessions.appendAssistantInitiative!.bind(h.sessions);
    const delivery = vi.spyOn(h.sessions, "appendAssistantInitiative").mockImplementationOnce(async (...args) => {
      await held;
      return create(...args);
    });
    await h.agent.start(); await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    const entries = change === "removed" ? [] : knowledge().entries.map((entry) => ({ ...entry, version: "2" }));
    h.knowledge({ ...knowledge(), knowledgeRevision: 2, entries });
    release();
    await tick(h.agent, 1);
    await vi.waitFor(async () => expect((await createProactiveStateStore(h.root).read()).proposals[0]?.status).toBe("cancelled"));
    expect(await h.sessions.getSessionById(pending.sessionId)).toBeNull();
    expect(h.changed.mock.calls.some(([event]) => event?.type === "proposal_delivered")).toBe(false);
    expect(h.review).not.toHaveBeenCalled();
  });

  test("the message cap prevents further paid reviews even when knowledge changes", async () => {
    const h = await fixture(); h.review.mockImplementation(async () => proposal());
    await h.update({ proactiveMessagesPerDay: 1 });
    await h.agent.start(); await tick(h.agent);
    expect((await h.sessions.listSessions()).sessions).toHaveLength(1);
    h.knowledge({ ...knowledge(), knowledgeRevision: 2 });
    await vi.waitFor(async () => expect((await h.agent.status()).state).toBe("budget_limited"));
    await tick(h.agent, 60 * 60_000);
    expect(h.review).toHaveBeenCalledTimes(1);
    expect(await h.agent.status()).not.toHaveProperty("proposals");
    await h.agent.dismiss((await createProactiveStateStore(h.root).read()).proposals[0]!.id);
    expect((await createProactiveStateStore(h.root).read()).deliveryUsage?.deliveredCount).toBe(1);
    expect((await h.agent.status()).deliveredToday).toBe(1);
  });
});
