import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { canDeliverProactiveProposal, isProactiveReviewEligible, validateProactiveDecision,
  type ProactiveDecision, type ProactiveProposal, type ProactiveReviewInput } from "../passive-learning/proactive/contracts.js";
import { countProactiveDeliveries, createProactiveStateStore } from "../passive-learning/proactive/store.js";
import { buildProactiveReviewMessages, createRuntimeProactiveModel } from "../passive-learning/proactive/model.js";
import type { LearningKnowledgeContext } from "../long-term-memory/maturation/contracts.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import type { ModelGatewayClient } from "../ports.js";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  await disposeCompositionFixtures();
});
async function directory() {
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-proactive-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-")); roots.push(root); return root;
}
function context(): LearningKnowledgeContext {
  return { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 3, knowledgeRevision: 3,
    referenceTime: new Date(NOW).toISOString(), omitted: 0,
    entries: [{ kind: "candidate", id: "candidate-a", version: "2", content: "A possible interest; untrusted text.",
      tags: [], score: 40, reason: "tentative", certainty: "inferred", mutable: true,
      lastReinforcedAt: null, reconsiderAt: null }] };
}
function decision(): ProactiveDecision {
  return { kind: "proposal", title: "An idea", message: "Would researching this help?", reason: "Relevant context",
    sources: [{ kind: "candidate", id: "candidate-a", version: "2" }],
    expiresAt: new Date(NOW + 86_400_000).toISOString(), reconsiderAt: null };
}
function noProposal(): ProactiveDecision {
  return { kind: "none", title: null, message: null, reason: "Nothing useful now", sources: [],
    expiresAt: null, reconsiderAt: null };
}
function reviewInput(): ProactiveReviewInput {
  return { reviewId: "review-1", modelProfileId: "default", context: context(), recentProposals: [], signal: new AbortController().signal };
}

describe("bound proactive decisions", () => {
  test("projects passive bounded data with no user turn or tool request", () => {
    const messages = buildProactiveReviewMessages(reviewInput());
    expect(messages.map(({ role }) => role)).toEqual(["system", "system", "system", "system"]);
    const knowledge = JSON.parse(messages[2]!.content);
    expect(knowledge).toMatchObject({ authority: "passive_reference", entries: context().entries });
    expect(Object.keys(knowledge)).not.toContain("tools");
    expect(() => buildProactiveReviewMessages({ ...reviewInput(), context: {
      ...context(), entries: Array.from({ length: 13 }, () => context().entries[0]!) } }))
      .toThrow("proactive_knowledge_context_too_large");
  });

  test("validates exact source versions, required expiry and bounded future reassessment", () => {
    expect(validateProactiveDecision(decision(), context().entries, NOW)).toEqual(decision());
    expect(validateProactiveDecision(noProposal(), [], NOW)).toEqual(noProposal());
    expect(() => validateProactiveDecision({ ...decision(), sources: [{ kind: "candidate", id: "candidate-a", version: "1" }] }, context().entries, NOW))
      .toThrow("proactive_source_stale_or_unknown");
    expect(() => validateProactiveDecision({ ...decision(), expiresAt: null }, context().entries, NOW))
      .toThrow("proactive_expiry_required");
    expect(() => validateProactiveDecision({ ...decision(), reconsiderAt: new Date(NOW).toISOString() }, context().entries, NOW))
      .toThrow("proactive_time_not_future");
    expect(() => validateProactiveDecision({ ...decision(), reconsiderAt: new Date(NOW + 31 * 86_400_000).toISOString() }, context().entries, NOW))
      .toThrow("proactive_time_too_distant");
  });

  test("uses the selected profile and one bounded model call without repair on invalid output", async () => {
    const base = await createRuntimeConfig();
    await writeFile(base.requestRunner.configPath, JSON.stringify({ schemaVersion: 2,
      models: { defaults: { profileId: "default", steps: {} } },
      context: { outputReserveTokens: 200, safetyReserveTokens: 50, attachmentReserveTokens: 1 },
      stepDefaults: { timeoutMs: 5000 }, steps: {} }));
    const config = { ...base, modelExecutionPolicies: { default: { policy: "execution-agent-v1" as const } },
      models: { defaults: { profileId: "default" },
      providers: { cloud: { type: "openai" } }, profiles: { default: {
        provider: "cloud", model: "scripted", contextWindowTokens: 8192 } } } };
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({ text: JSON.stringify(noProposal()), meta: { providerCompletionReason: "stop" } }));
    const model = createRuntimeProactiveModel({ config, models: { invoke,
      invokeRaw: vi.fn(async () => { throw new Error("unexpected_raw"); }) } });
    await expect(model.review(reviewInput())).resolves.toEqual(noProposal());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ modelStep: "learning.batch",
      modelPreference: { profileId: "default", scope: "all" } });
    invoke.mockResolvedValueOnce({ text: JSON.stringify({ ...noProposal(), reason: null }), meta: { providerCompletionReason: "stop" } });
    await expect(model.review({ ...reviewInput(), reviewId: "optional-reason" })).resolves.toMatchObject({ kind: "none" });
    expect(invoke).toHaveBeenCalledTimes(2);
    invoke.mockResolvedValueOnce({ text: "not JSON", meta: { providerCompletionReason: "stop" } });
    await expect(model.review({ ...reviewInput(), reviewId: "review-2" })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

describe("durable proactive receipt lifecycle", () => {
  test("commits before delivery, replays once, and persists a stable session identity", async () => {
    const root = await directory();
    const store = createProactiveStateStore(root);
    const input = { reviewId: "r1", expectedRevision: 0, knowledgeRevision: 3, decision: decision(), now: NOW };
    const first = await store.commitReview(input);
    const replay = await store.commitReview(input);
    expect(replay).toEqual(first);
    const proposal = first.proposals[0]!;
    expect(proposal.status).toBe("pending");
    await store.markDelivered(proposal.id, NOW + 1);
    await store.dismiss(proposal.id, NOW + 2);
    await store.markDelivered(proposal.id, NOW + 3);
    expect((await createProactiveStateStore(root).read()).proposals).toMatchObject([
      { id: proposal.id, sessionId: proposal.sessionId, status: "dismissed" }]);
  });

  test("rejects concurrent stale reviews and blocks disabled late commits", async () => {
    const root = await directory();
    const one = createProactiveStateStore(root);
    const two = createProactiveStateStore(root);
    const create = (reviewId: string) => ({ reviewId, expectedRevision: 0, knowledgeRevision: 3, decision: noProposal(), now: NOW });
    const results = await Promise.allSettled([one.commitReview(create("one")), two.commitReview(create("two"))]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const current = await one.read();
    await expect(one.commitReview({ ...create("late"), expectedRevision: current.revision,
      assertCurrent: () => { throw new Error("disabled"); } })).rejects.toThrow("disabled");
    expect(await one.read()).toEqual(current);
  });

  test("cancels pending delivery without deleting existing receipts", async () => {
    const store = createProactiveStateStore(await directory());
    await store.commitReview({ reviewId: "r1", expectedRevision: 0, knowledgeRevision: 3, decision: decision(), now: NOW });
    const cancelled = await store.cancelPending(NOW + 1);
    expect(cancelled.proposals).toMatchObject([{ status: "cancelled" }]);
    expect(await store.cancelPending(NOW + 2)).toEqual(cancelled);
  });

  test("bounds receipt count and byte input without periodic status writes", async () => {
    const root = await directory();
    const store = createProactiveStateStore(root);
    let revision = 0;
    for (let index = 0; index < 102; index += 1) {
      const state = await store.commitReview({ reviewId: `r${index}`, expectedRevision: revision,
        knowledgeRevision: index, decision: decision(), now: NOW });
      revision = (await store.markDelivered(state.proposals.at(-1)!.id, NOW + 1, NOW)).revision;
    }
    expect((await store.read()).proposals).toHaveLength(100);
    expect(countProactiveDeliveries(await store.read(), NOW)).toBe(102);
    const file = join(root, "proactive.json");
    const before = (await stat(file)).mtimeMs;
    await store.read(); await store.read();
    expect((await stat(file)).mtimeMs).toBe(before);
    const state = JSON.parse(await readFile(file, "utf8"));
    expect(state.proposals[0].reviewId).toBe("r2");
    await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
    await expect(store.read()).rejects.toThrow("proactive_state_too_large");
  });
});

describe("independent proactive admission", () => {
  test("requires eligible knowledge or a due reassessment and enforces cadence", async () => {
    const store = createProactiveStateStore(await directory());
    const state = await store.commitReview({ reviewId: "r", expectedRevision: 0, knowledgeRevision: 3,
      decision: noProposal(), now: NOW });
    const base = { enabled: true, insideWindow: true, interactiveBusy: false, hasKnowledge: true,
      now: NOW + 60_000, nextAllowedAt: NOW, knowledgeRevision: 3, state };
    expect(isProactiveReviewEligible(base)).toBe(false);
    expect(isProactiveReviewEligible({ ...base, knowledgeRevision: 4 })).toBe(true);
    expect(isProactiveReviewEligible({ ...base, state: { ...state, nextReviewAt: new Date(NOW + 1).toISOString() } })).toBe(true);
    expect(isProactiveReviewEligible({ ...base, knowledgeRevision: 4, nextAllowedAt: NOW + 120_000 })).toBe(false);
    expect(isProactiveReviewEligible({ ...base, knowledgeRevision: 4, enabled: false })).toBe(false);
  });

  test("delivery checks exact current sources, cancellation, windows and expiry", async () => {
    const store = createProactiveStateStore(await directory());
    const state = await store.commitReview({ reviewId: "r", expectedRevision: 0, knowledgeRevision: 3,
      decision: decision(), now: NOW });
    const proposal = state.proposals[0]!;
    const base = { proposal, enabled: true, insideWindow: true, generationCurrent: true,
      now: NOW + 1, currentSources: context().entries };
    expect(canDeliverProactiveProposal(base)).toBe(true);
    expect(canDeliverProactiveProposal({ ...base, currentSources: [] })).toBe(false);
    expect(canDeliverProactiveProposal({ ...base, insideWindow: false })).toBe(false);
    expect(canDeliverProactiveProposal({ ...base, generationCurrent: false })).toBe(false);
    expect(canDeliverProactiveProposal({ ...base, enabled: false })).toBe(false);
    expect(canDeliverProactiveProposal({ ...base, now: Date.parse(proposal.expiresAt) })).toBe(false);
  });
});
