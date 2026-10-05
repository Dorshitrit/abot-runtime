import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { LearningMemoryService, LearningKnowledgeContext } from "../long-term-memory/maturation/contracts.js";
import type { PassiveLearningPreferences } from "../passive-learning/contracts.js";
import { CoWorkerProactiveAgent } from "../passive-learning/proactive/agent.js";
import { createProactiveStateStore } from "../passive-learning/proactive/store.js";
import { CoWorkerResourceBudget } from "../passive-learning/resources/budget.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS } from "../passive-learning/resources/contracts.js";
import { createSparkClearFixture, createSparkClearGate } from "./support/spark-clear-fixture.js";

const NOW = Date.parse("2026-10-02T09:00:00Z");
const fixtures: Awaited<ReturnType<typeof createSparkClearFixture>>[] = [];
const agents: CoWorkerProactiveAgent[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.stop()));
  vi.useRealTimers(); vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function fixture() {
  const f = await createSparkClearFixture(); fixtures.push(f);
  const preferences: PassiveLearningPreferences = { enabled: false, processingPaused: true,
    excludedApplications: [], proactiveEnabled: true, proactiveModelProfileId: "fixture",
    proactiveIntervalMinutes: 1, proactiveMessagesPerDay: 2, resourceLimits: DEFAULT_CO_WORKER_RESOURCE_LIMITS };
  const knowledge: LearningKnowledgeContext = { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1, knowledgeRevision: 1,
    referenceTime: new Date(NOW).toISOString(), omitted: 0,
    entries: [{ kind: "candidate", id: "interest", version: "1", content: "An interest", tags: [], score: 40,
      reason: "Tentative", certainty: "inferred", mutable: true, lastReinforcedAt: null, reconsiderAt: null }] };
  const unexpectedMemoryOperation = async (): Promise<never> => { throw new Error("unexpected_memory_operation"); };
  const memory: LearningMemoryService = { overview: async () => knowledge, sourceVersions: async () => knowledge.entries,
    policy: unexpectedMemoryOperation, configurePolicy: unexpectedMemoryOperation, reviewAdmission: unexpectedMemoryOperation,
    nextReconsiderationAt: unexpectedMemoryOperation, reconsiderationContext: unexpectedMemoryOperation,
    maintenance: unexpectedMemoryOperation, nextExpiryAt: unexpectedMemoryOperation, prepare: unexpectedMemoryOperation,
    apply: unexpectedMemoryOperation, list: unexpectedMemoryOperation, receipt: unexpectedMemoryOperation };
  const store = createProactiveStateStore(f.directory);
  const reserved = await store.reserveReviewAttempt({ reviewId: "prepared", expectedRevision: 0,
    knowledgeRevision: 1, profileId: "fixture", now: NOW, assertCurrent() {} });
  const saved = await store.commitReview({ reviewId: "prepared", expectedRevision: reserved!.revision,
    knowledgeRevision: 1, now: NOW, assertCurrent() {}, decision: {
      kind: "proposal", title: "A saved idea", message: "An already prepared idea", handoffBrief: "Background for an already prepared idea.",
      reason: "An interest", sources: [{ kind: "candidate", id: "interest", version: "1" }],
      expiresAt: new Date(NOW + 86_400_000).toISOString(), reconsiderAt: null,
    } });
  const delivered = createSparkClearGate(); const enteringAdmission = createSparkClearGate();
  const changed = vi.fn((event?: { type: string }) => { if (event?.type === "proposal_delivered") delivered.open(); });
  const run = f.admission.run.bind(f.admission);
  const admissionRun = vi.spyOn(f.admission, "run").mockImplementation((...args) => {
    enteringAdmission.open(); return run(...args);
  });
  const review = vi.fn(async () => { throw new Error("unexpected_model_call"); });
  const budget = new CoWorkerResourceBudget({ directory: f.directory, limits: () => DEFAULT_CO_WORKER_RESOURCE_LIMITS });
  const agent = new CoWorkerProactiveAgent({ directory: f.directory, memory, sessions: f.sessions, budget,
    deliveryAdmission: f.admission, model: { review, validateProfile() {} },
    context: { preferences: () => preferences, changed, assertProcessingAllowed() {},
      isInteractiveBusy: () => false, isStarted: () => true } });
  agents.push(agent);
  return { ...f, agent, budget, store, proposalId: saved.proposals[0]!.id, changed, delivered, enteringAdmission, admissionRun, review,
    async begin() { await agent.start(); await vi.advanceTimersByTimeAsync(1); } };
}

test("clear cannot erase a delivery between transcript append and delivered receipt/event", async () => {
  const f = await fixture(); const appended = createSparkClearGate(); const finishDelivery = createSparkClearGate();
  const ensureWindow = f.budget.ensureCurrentWindow.bind(f.budget);
  vi.spyOn(f.budget, "ensureCurrentWindow").mockImplementation(async () => {
    appended.open(); await finishDelivery.waiting; return ensureWindow();
  });
  await f.begin(); await appended.waiting;
  try {
    expect((await f.sessions.getSessionById(SPARK_SESSION_ID))?.messages).toHaveLength(1);
    await expect(f.sessions.clearSessionMessages(SPARK_SESSION_ID)).rejects.toThrow("spark_chat_busy");
    expect((await f.store.read()).proposals[0]!.status).toBe("pending");
  } finally { finishDelivery.open(); await f.delivered.waiting; }
  expect((await f.store.read()).proposals[0]!.status).toBe("delivered");
  expect((await f.sessions.getSessionById(SPARK_SESSION_ID))?.messages[0]?.initiative?.proposalId).toBe(f.proposalId);
  expect(f.changed.mock.calls.filter(([event]) => event?.type === "proposal_delivered")).toHaveLength(1);
  expect(f.review).not.toHaveBeenCalled();
});

test("a delivery arriving during clear waits then appends to the newly empty transcript", async () => {
  const f = await fixture(); await f.sessions.appendMessage(SPARK_SESSION_ID, "user", "Old history");
  const clearing = createSparkClearGate(); const finishClear = createSparkClearGate();
  vi.spyOn(f.backing.requestLifecycle!, "listWaiting").mockImplementationOnce(async () => {
    clearing.open(); await finishClear.waiting; return [];
  });
  const append = vi.spyOn(f.sessions, "appendAssistantInitiative");
  const clear = f.sessions.clearSessionMessages(SPARK_SESSION_ID); await clearing.waiting;
  try {
    await f.begin();
    await Promise.race([f.enteringAdmission.waiting, f.delivered.waiting]);
    expect(append).not.toHaveBeenCalled();
  } finally { finishClear.open(); await clear; await f.delivered.waiting; }
  const messages = (await f.sessions.getSessionById(SPARK_SESSION_ID))!.messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]!.initiative?.proposalId).toBe(f.proposalId);
  expect((await f.store.read()).proposals[0]!.status).toBe("delivered");
  expect(f.review).not.toHaveBeenCalled();
});

test("a saved request approval does not add a new proactive delivery restriction", async () => {
  const f = await fixture();
  const waiting = vi.spyOn(f.backing.requestLifecycle!, "listWaiting").mockRejectedValue(new Error("must_not_consult_request_approval"));
  await f.begin(); await f.delivered.waiting;
  expect(waiting).not.toHaveBeenCalled();
  expect((await f.store.read()).proposals[0]!.status).toBe("delivered");
  expect(f.review).not.toHaveBeenCalled();
});
