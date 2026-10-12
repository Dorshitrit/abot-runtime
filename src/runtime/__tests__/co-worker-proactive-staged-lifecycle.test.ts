import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoWorkerProactiveAgent } from "../passive-learning/proactive/agent.js";
import { createRuntimeProactiveModel } from "../passive-learning/proactive/model.js";
import { createProactiveStateStore } from "../passive-learning/proactive/store.js";
import { ensureSparkSession } from "../../sessions/spark-session.js";
import { createFileSessionStore } from "../adapters/file-session-store.js";
import { CoWorkerResourceBudget } from "../passive-learning/resources/budget.js";
import { createCoWorkerResourceGateway } from "../passive-learning/resources/gateway.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS } from "../passive-learning/resources/contracts.js";
import type { PassiveLearningPreferences } from "../passive-learning/contracts.js";
import type { LearningKnowledgeContext, LearningMemoryService } from "../long-term-memory/maturation/contracts.js";
import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const SOURCE = { sourceRefs: ["k1"] };
const OBJECTIVE = { objective: "Offer help with the possible project" };
const MESSAGE = { title: "A possible review", message: "Would reviewing this project help?",
  handoffBrief: "SPARK background: a possible ongoing project could benefit from review; the user has not requested work yet." };
const CONTENT = [MESSAGE.message, MESSAGE.title, MESSAGE.handoffBrief];
const TIMING = { expiresInMinutes: 60, reconsiderInMinutes: null };
const roots: string[] = [];
const agents: CoWorkerProactiveAgent[] = [];
const reviewCompletion = new WeakMap<CoWorkerProactiveAgent, () => Promise<void>>();
const reviewScheduled = new WeakMap<CoWorkerProactiveAgent, () => Promise<void>>();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  await disposeCompositionFixtures();
});

function response(value: unknown) { return { text: typeof value === "string" ? value : JSON.stringify(value), meta: { providerCompletionReason: "stop" } }; }

async function fixture(modelCallsPerDay = 24) {
  const base = await createRuntimeConfig();
  await writeFile(base.requestRunner.configPath, JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "default", steps: {} } },
    context: { outputReserveTokens: 200, safetyReserveTokens: 50, attachmentReserveTokens: 1 },
    stepDefaults: { timeoutMs: 5000 }, steps: {} }));
  const config: RuntimeConfig = { ...base, modelExecutionPolicies: { default: { policy: "supervisor-worker-v1" } },
    models: { defaults: { profileId: "default" }, providers: { scripted: { type: "openai" } },
      profiles: { default: { provider: "scripted", model: "scripted", contextWindowTokens: 8192 } } } };
  const parent = join(process.cwd(), ".codex/artifacts/proactive-super-lifecycle-20260927");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-")); roots.push(root);
  let preferences: PassiveLearningPreferences = { enabled: false, processingPaused: true, excludedApplications: [],
    modelProfileId: "default", proactiveEnabled: true, proactiveIntervalMinutes: 1, proactiveMessagesPerDay: 2,
    resourceLimits: { ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, modelCallsPerDay } };
  let busy = false;
  let knowledge: LearningKnowledgeContext = { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1, knowledgeRevision: 1,
    referenceTime: new Date(NOW).toISOString(), omitted: 0,
    entries: [{ kind: "candidate", id: "candidate-one", version: "1", content: "A possible ongoing project",
      tags: [], score: 40, reason: "Tentative", certainty: "inferred", mutable: true,
      lastReinforcedAt: null, reconsiderAt: null }] };
  const memory = { overview: async () => ({ ...knowledge, referenceTime: new Date(Date.now()).toISOString() }),
    sourceVersions: async () => knowledge.entries } as unknown as LearningMemoryService;
  const budget = new CoWorkerResourceBudget({ directory: root, limits: () => preferences.resourceLimits! });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const gateway = createCoWorkerResourceGateway({ budget, activity: "proactive", supportsParallel: () => false,
    assertActivityAllowed() { if (!preferences.proactiveEnabled || busy) throw new Error("proactive_disabled"); },
    gateway: { invoke, invokeRaw: vi.fn(async () => { throw new Error("unexpected_raw"); }) } });
  const sessions = createFileSessionStore({ sessionsDir: join(root, "sessions") });
  const model = createRuntimeProactiveModel({ config, models: gateway, sessions });
  const build = () => {
    let notifyChanged!: () => void;
    let nextChange = new Promise<void>(resolve => { notifyChanged = resolve; });
    const changed = () => {
      notifyChanged();
      nextChange = new Promise<void>(resolve => { notifyChanged = resolve; });
    };
    const agent = new CoWorkerProactiveAgent({ directory: root, memory, model, sessions, budget,
      context: { preferences: () => preferences, isStarted: () => true, isInteractiveBusy: () => busy,
        changed, assertProcessingAllowed() { throw new Error("processing_off"); } } });
    reviewCompletion.set(agent, async () => {
      while (true) {
        // Capture before reading status so a concurrent completion cannot be missed.
        const changed = nextChange;
        if ((await agent.status()).state !== "reviewing") return;
        await changed;
      }
    });
    reviewScheduled.set(agent, async () => {
      while (true) {
        // Interactive release rearms asynchronously; observe admission before advancing time.
        const changed = nextChange;
        if ((await agent.status()).nextReviewAt !== undefined) return;
        await changed;
      }
    });
    agents.push(agent); return agent;
  };
  let agent = build();
  return { invoke, budget, sessions, model, memory, store: createProactiveStateStore(root), get agent() { return agent; },
    restart: async () => { await agent.stop(); agent = build(); await agent.start(); },
    update: async (changes: Partial<PassiveLearningPreferences>) => { preferences = { ...preferences, ...changes }; await agent.preferencesChanged(); },
    setBudget: async (limit: number) => { preferences = { ...preferences,
      resourceLimits: { ...preferences.resourceLimits!, modelCallsPerDay: limit } }; await agent.preferencesChanged(); },
    setBusy: (value: boolean) => { busy = value; },
    changeKnowledge: () => { knowledge = { ...knowledge, knowledgeRevision: knowledge.knowledgeRevision + 1,
      entries: knowledge.entries.map(entry => ({ ...entry, version: "2" })) }; agent.knowledgeChanged(); },
  };
}

async function tick(agent: CoWorkerProactiveAgent, milliseconds = 60_001) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  const waitForReviewCompletion = reviewCompletion.get(agent);
  if (!waitForReviewCompletion) throw new Error("proactive_test_agent_not_registered");
  await waitForReviewCompletion();
}
function queue(f: Awaited<ReturnType<typeof fixture>>, values: readonly unknown[]) {
  for (const value of values) f.invoke.mockResolvedValueOnce(response(value));
}
function holdNextCall(f: Awaited<ReturnType<typeof fixture>>) {
  f.invoke.mockImplementationOnce(params => new Promise((_resolve, reject) => {
    params.abortSignal.addEventListener("abort", () => reject(params.abortSignal.reason), { once: true });
  }));
}

function styleReferences(value: unknown) {
  return (value as { content: string }[]).flatMap(message => {
    if (!message.content.startsWith("{")) return [];
    const parsed = JSON.parse(message.content);
    return parsed.kind === "co_worker_proactive_conversation_style_v1" ? [parsed] : [];
  });
}

describe("proactive style lifecycle remains presentation-only", () => {
  test.each(["change", "clear"] as const)("restart after %s reuses decisions and reauthors against retained human history", async action => {
    const f = await fixture(3);
    await ensureSparkSession(f.sessions);
    await f.sessions.appendMessage("spark-companion", "user", "אפשר להמשיך בעברית?");
    queue(f, [SOURCE, OBJECTIVE, MESSAGE.message]);
    await f.agent.start(); await tick(f.agent);
    expect((await f.store.read()).reviewProgress?.stages.map(stage => stage.key))
      .toEqual(["sources", "objective", "message.raw.v1"]);
    expect(f.invoke).toHaveBeenCalledTimes(3);
    await f.agent.stop();
    if (action === "change") await f.sessions.appendMessage("spark-companion", "user", "Please use English.");
    else await f.sessions.clearSessionMessages("spark-companion");
    await f.restart(); await f.setBudget(7); queue(f, [...CONTENT, TIMING]); await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(7);
    expect((await f.budget.status()).modelCalls).toBe(7);
    const references = styleReferences(f.invoke.mock.calls[3]![0].messages);
    expect(references).toHaveLength(action === "change" ? 1 : 0);
    if (action === "change") expect(references[0].entries.at(-1).content).toBe("Please use English.");
    expect((await f.store.read()).proposals).toMatchObject([{ status: "delivered" }]);
  });

  test("a new human chat message cannot admit a review without new knowledge or a due reconsideration", async () => {
    const f = await fixture();
    await ensureSparkSession(f.sessions);
    await f.sessions.appendMessage("spark-companion", "user", "Earlier human message.");
    queue(f, [SOURCE, OBJECTIVE, ...CONTENT, TIMING]);
    await f.agent.start(); await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(6);
    f.setBusy(true);
    const release = f.agent.beginInteractive();
    await f.sessions.appendMessage("spark-companion", "user", "הודעה חדשה בעברית.");
    f.setBusy(false); release();
    await tick(f.agent, 3_600_000);
    expect(f.invoke).toHaveBeenCalledTimes(6);
    expect((await f.store.read()).proposals).toHaveLength(1);
  });
});

describe("SUPER proactive durable stage lifecycle", () => {
  test("quota deferral survives restart and charges only the unfinished responsibilities", async () => {
    const f = await fixture(2); queue(f, [SOURCE, OBJECTIVE]);
    await f.agent.start(); await tick(f.agent);
    expect((await f.store.read()).reviewProgress?.stages.map(stage => stage.key)).toEqual(["sources", "objective"]);
    expect((await f.store.read()).reviewAttempt).toMatchObject({ status: "running", method: "super-v2" });
    expect((await f.budget.status()).modelCalls).toBe(2);
    await f.restart(); await f.setBudget(6); queue(f, [...CONTENT, TIMING]); await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(6);
    expect((await f.budget.status()).modelCalls).toBe(6);
    const state = await f.store.read();
    expect(state.reviewAttempt).toBeUndefined(); expect(state.reviewProgress).toBeUndefined();
    expect(state.proposals).toMatchObject([{ status: "delivered" }]);
    expect((await f.sessions.listSessions()).sessions).toHaveLength(1);
  });

  test("raw text survives disk checkpoint restart and is delivered exactly once only after timing", async () => {
    const f = await fixture(5);
    const message = '  בדיקת נדל"ן\nC:\\work\n\nשורה אחרונה 🧪  ';
    queue(f, [SOURCE, OBJECTIVE, message, MESSAGE.title, MESSAGE.handoffBrief]);
    await f.agent.start(); await tick(f.agent);
    const paused = await f.store.read();
    expect(paused.reviewProgress?.stages.map(stage => stage.key)).toEqual(["sources", "objective", "message.raw.v1", "title", "handoff"]);
    expect(paused.reviewProgress?.stages[2]?.response).toBe(message);
    expect(paused.proposals).toHaveLength(0);
    expect(await f.sessions.getSessionById("spark-companion")).toBeNull();
    await f.restart(); await f.setBudget(6); queue(f, [TIMING]); await tick(f.agent);
    const delivered = await f.sessions.getSessionById("spark-companion");
    expect(delivered?.messages).toHaveLength(1);
    expect(delivered?.messages[0]?.content).toBe(message);
    expect(delivered?.messages[0]?.initiative).toMatchObject({ handoffBrief: MESSAGE.handoffBrief });
    expect((await f.store.read()).proposals[0]?.message).toBe(message);
    await f.restart(); await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(6);
    expect((await f.sessions.getSessionById("spark-companion"))?.messages).toHaveLength(1);
  });

  test.each(["stop", "off", "interactive"])("%s retains the accepted prefix and resumes it", async control => {
    const f = await fixture(); queue(f, [SOURCE]); holdNextCall(f);
    await f.agent.start(); await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(2));
    let release: (() => void) | undefined;
    if (control === "stop") await f.agent.stop();
    if (control === "off") await f.update({ proactiveEnabled: false });
    if (control === "interactive") { f.setBusy(true); release = f.agent.beginInteractive(); }
    await vi.waitFor(async () => expect((await f.agent.status()).state).not.toBe("reviewing"));
    expect((await f.store.read()).reviewProgress?.stages.map(stage => stage.key)).toEqual(["sources"]);
    expect((await f.store.read()).reviewAttempt?.status).toBe("running");
    queue(f, [OBJECTIVE, ...CONTENT, TIMING]);
    if (control === "stop") await f.restart();
    if (control === "off") await f.update({ proactiveEnabled: true });
    if (control === "interactive") {
      f.setBusy(false); release!();
      await reviewScheduled.get(f.agent)!();
    }
    await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(7);
    expect((await f.store.read()).proposals).toMatchObject([{ status: "delivered" }]);
  });

  test("terminal model failure remains blocked across restart until an explicit control resume", async () => {
    const f = await fixture(); queue(f, [SOURCE, { objective: "" }]);
    await f.agent.start(); await tick(f.agent);
    expect((await f.store.read()).reviewAttempt?.status).toBe("failed");
    await f.restart(); await tick(f.agent, 3_600_000);
    expect(f.invoke).toHaveBeenCalledTimes(2);
    await f.update({ proactiveEnabled: false }); queue(f, [OBJECTIVE, ...CONTENT, TIMING]);
    await f.update({ proactiveEnabled: true }); await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(7);
    expect((await f.store.read()).reviewProgress).toBeUndefined();
  });

  test("changed sources after preemption discard the old prefix before another call", async () => {
    const f = await fixture(); queue(f, [SOURCE]); holdNextCall(f);
    await f.agent.start(); await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(2));
    await f.agent.stop(); f.changeKnowledge(); queue(f, [SOURCE, OBJECTIVE, ...CONTENT, TIMING]);
    await f.restart(); await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(8);
    expect((await f.store.read()).proposals[0]?.sources).toEqual([{ kind: "candidate", id: "candidate-one", version: "2" }]);
  });

  test("expired progress cannot survive the next owner admission", async () => {
    const f = await fixture(1); queue(f, [SOURCE]);
    await f.agent.start(); await tick(f.agent); await f.agent.stop();
    expect((await f.store.read()).reviewProgress?.stages).toHaveLength(1);
    vi.setSystemTime(Date.parse((await f.store.read()).reviewProgress!.expiresAt) + 1);
    await f.restart();
    expect((await f.store.read()).reviewProgress).toBeUndefined();
  });
});


describe("SUPER proactive quota and upgrade regressions", () => {
  test.each([1, 2, 3])("daily quota %i completes across real budget resets and restarts without reauthoring", async limit => {
    const f = await fixture(limit); queue(f, [SOURCE, OBJECTIVE, ...CONTENT, TIMING]);
    await f.agent.start(); await tick(f.agent);
    const initial = (await f.store.read()).reviewProgress!;
    expect(Date.parse(initial.expiresAt) - Date.parse(initial.referenceTime)).toBe(6 * 86_400_000);
    for (let accepted = limit; accepted < 6; accepted += limit) {
      expect(f.invoke).toHaveBeenCalledTimes(accepted);
      expect((await f.store.read()).reviewProgress?.expiresAt).toBe(initial.expiresAt);
      const usage = await f.budget.status();
      expect(usage.modelCalls).toBe(limit);
      // Review completion precedes asynchronous rearming; await its published schedule.
      await reviewScheduled.get(f.agent)!();
      expect((await f.agent.status()).nextReviewAt).toBe(new Date(usage.resetsAt).toISOString());
      await f.agent.stop();
      vi.setSystemTime(usage.resetsAt + 1000);
      await f.restart(); await tick(f.agent);
    }
    expect(f.invoke).toHaveBeenCalledTimes(6);
    expect((await f.store.read()).proposals).toMatchObject([{ status: "delivered", message: MESSAGE.message }]);
    expect((await f.sessions.getSessionById("spark-companion"))?.messages).toHaveLength(1);
  });

  test("an exhausted quota waits for reset when restored progress has the old completed sequence", async () => {
    const f = await fixture(4); queue(f, [SOURCE, OBJECTIVE, MESSAGE.message, MESSAGE.title]);
    await f.agent.start(); await tick(f.agent); await f.agent.stop();
    const state = await f.store.read(); const saved = state.reviewProgress!;
    const legacy = { ...saved, stages: [saved.stages[0]!, saved.stages[1]!,
      { ...saved.stages[2]!, key: "message", response: JSON.stringify(MESSAGE) },
      { ...saved.stages[3]!, key: "timing", response: JSON.stringify(TIMING) }] };
    await f.store.saveReviewProgress({ reviewId: state.reviewAttempt!.reviewId, expectedRevision: state.revision,
      progress: legacy, assertCurrent() {} });
    await f.restart(); await tick(f.agent, 600_001);
    const usage = await f.budget.status();
    expect((await f.agent.status()).nextReviewAt).toBe(new Date(usage.resetsAt).toISOString());
    expect(f.invoke).toHaveBeenCalledTimes(4);
    expect((await f.store.read()).proposals).toHaveLength(0);
  });
});


describe("shared quota and current replay admission", () => {
  test("other activity may consume 23 of 24 daily calls without expiring progressing proactive work", async () => {
    const f = await fixture(24); queue(f, [SOURCE, OBJECTIVE, ...CONTENT, TIMING]);
    let deadline: string | undefined;
    for (let day = 0; day < 6; day += 1) {
      for (let call = 0; call < 23; call += 1) {
        const release = await f.budget.reserve({ kind: "model", activity: "processing", supportsParallel: false,
          signal: new AbortController().signal, assertActivityAllowed() {} }); release();
      }
      await f.restart(); await tick(f.agent);
      expect(f.invoke).toHaveBeenCalledTimes(day + 1);
      expect((await f.budget.status()).modelCalls).toBe(24);
      const state = await f.store.read();
      if (day === 5) { expect(state.proposals).toMatchObject([{ status: "delivered" }]); break; }
      deadline ??= state.reviewProgress!.expiresAt;
      expect(state.reviewProgress?.expiresAt).toBe(deadline);
      expect(state.reviewProgress?.stages).toHaveLength(day + 1);
      await f.agent.stop(); vi.setSystemTime((await f.budget.status()).resetsAt + 1000);
    }
    // Six simulated days include 138 real durable budget writes, beyond the usual
    // single-cycle fixture. Keep a bounded wall-clock allowance for loaded CI.
  }, 15_000);

  test.each(["unchanged", "changed", "cleared"])("a complete disk checkpoint with %s style proves replay before bypassing quota", async style => {
    const f = await fixture(6);
    await ensureSparkSession(f.sessions); await f.sessions.appendMessage("spark-companion", "user", "Please be concise.");
    const context = await f.memory.overview(); const initial = await f.store.read();
    let state = (await f.store.reserveReviewAttempt({ reviewId: "saved-complete", profileId: "default", method: "super-v2",
      knowledgeRevision: context.knowledgeRevision, expectedRevision: initial.revision, now: Date.now(), assertCurrent() {} }))!;
    queue(f, [SOURCE, OBJECTIVE, ...CONTENT, TIMING]);
    await f.model.review({ reviewId: "saved-complete", modelProfileId: "default", context, recentProposals: [],
      signal: new AbortController().signal, progress: { read: () => state.reviewProgress,
        async save(progress) { state = await f.store.saveReviewProgress({ reviewId: "saved-complete",
          expectedRevision: state.revision, progress, assertCurrent() {} }); } } });
    // Simulate interruption after the last durable stage but before the canonical commit.
    if (style === "changed") await f.sessions.appendMessage("spark-companion", "user", "אפשר בעברית?");
    if (style === "cleared") await f.sessions.clearSessionMessages("spark-companion");
    await f.restart(); await tick(f.agent, 600_001);
    expect(f.invoke).toHaveBeenCalledTimes(6);
    const result = await f.store.read();
    if (style === "unchanged") { expect(result.proposals).toMatchObject([{ status: "delivered" }]); return; }
    expect(result.proposals).toHaveLength(0);
    expect(result.reviewProgress).toEqual(state.reviewProgress);
    expect((await f.agent.status()).nextReviewAt).toBe(new Date((await f.budget.status()).resetsAt).toISOString());
  });
});
