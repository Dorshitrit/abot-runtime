import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoWorkerProactiveAgent } from "../passive-learning/proactive/agent.js";
import { createRuntimeProactiveModel } from "../passive-learning/proactive/model.js";
import { createProactiveStateStore } from "../passive-learning/proactive/store.js";
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
const MESSAGE = { title: "A possible review", message: "Would reviewing this project help?" };
const TIMING = { expiresInMinutes: 60, reconsiderInMinutes: null };
const roots: string[] = [];
const agents: CoWorkerProactiveAgent[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  await disposeCompositionFixtures();
});

function response(value: unknown) { return { text: JSON.stringify(value), meta: { providerCompletionReason: "stop" } }; }

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
  const model = createRuntimeProactiveModel({ config, models: gateway });
  const sessions = createFileSessionStore({ sessionsDir: join(root, "sessions") });
  const build = () => {
    const agent = new CoWorkerProactiveAgent({ directory: root, memory, model, sessions, budget,
      context: { preferences: () => preferences, isStarted: () => true, isInteractiveBusy: () => busy,
        changed() {}, assertProcessingAllowed() { throw new Error("processing_off"); } } });
    agents.push(agent); return agent;
  };
  let agent = build();
  return { invoke, budget, sessions, store: createProactiveStateStore(root), get agent() { return agent; },
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
  await vi.waitFor(async () => { expect((await agent.status()).state).not.toBe("reviewing"); });
}
function queue(f: Awaited<ReturnType<typeof fixture>>, values: readonly unknown[]) {
  for (const value of values) f.invoke.mockResolvedValueOnce(response(value));
}
function holdNextCall(f: Awaited<ReturnType<typeof fixture>>) {
  f.invoke.mockImplementationOnce(params => new Promise((_resolve, reject) => {
    params.abortSignal.addEventListener("abort", () => reject(params.abortSignal.reason), { once: true });
  }));
}

describe("SUPER proactive durable stage lifecycle", () => {
  test("quota deferral survives restart and charges only the unfinished responsibilities", async () => {
    const f = await fixture(2); queue(f, [SOURCE, OBJECTIVE]);
    await f.agent.start(); await tick(f.agent);
    expect((await f.store.read()).reviewProgress?.stages.map(stage => stage.key)).toEqual(["sources", "objective"]);
    expect((await f.store.read()).reviewAttempt).toMatchObject({ status: "running", method: "super-v2" });
    expect((await f.budget.status()).modelCalls).toBe(2);
    await f.restart(); await f.setBudget(4); queue(f, [MESSAGE, TIMING]); await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(4);
    expect((await f.budget.status()).modelCalls).toBe(4);
    const state = await f.store.read();
    expect(state.reviewAttempt).toBeUndefined(); expect(state.reviewProgress).toBeUndefined();
    expect(state.proposals).toMatchObject([{ status: "delivered" }]);
    expect((await f.sessions.listSessions()).sessions).toHaveLength(1);
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
    queue(f, [OBJECTIVE, MESSAGE, TIMING]);
    if (control === "stop") await f.restart();
    if (control === "off") await f.update({ proactiveEnabled: true });
    if (control === "interactive") { f.setBusy(false); release!(); }
    await tick(f.agent);
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(5));
    await vi.waitFor(async () => expect((await f.store.read()).proposals).toMatchObject([{ status: "delivered" }]));
  });

  test("terminal model failure remains blocked across restart until an explicit control resume", async () => {
    const f = await fixture(); queue(f, [SOURCE, { objective: "" }]);
    await f.agent.start(); await tick(f.agent);
    expect((await f.store.read()).reviewAttempt?.status).toBe("failed");
    await f.restart(); await tick(f.agent, 3_600_000);
    expect(f.invoke).toHaveBeenCalledTimes(2);
    await f.update({ proactiveEnabled: false }); queue(f, [OBJECTIVE, MESSAGE, TIMING]);
    await f.update({ proactiveEnabled: true }); await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(5);
    expect((await f.store.read()).reviewProgress).toBeUndefined();
  });

  test("changed sources after preemption discard the old prefix before another call", async () => {
    const f = await fixture(); queue(f, [SOURCE]); holdNextCall(f);
    await f.agent.start(); await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(2));
    await f.agent.stop(); f.changeKnowledge(); queue(f, [SOURCE, OBJECTIVE, MESSAGE, TIMING]);
    await f.restart(); await tick(f.agent);
    expect(f.invoke).toHaveBeenCalledTimes(6);
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
