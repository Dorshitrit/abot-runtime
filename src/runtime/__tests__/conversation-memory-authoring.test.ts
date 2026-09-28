import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { toOllamaFormat } from "../../model-gateway/structured-output/projection.js";
import type { LearningKnowledgeContext, LearningMemoryService } from "../long-term-memory/maturation/contracts.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { prepareConversationMemoryAuthoring } from "../long-term-memory/conversation-authoring/context.js";
import { parseConversationMemoryCandidates, MAX_CONVERSATION_MEMORY_CANDIDATES } from "../long-term-memory/conversation-authoring/contract.js";
import { scheduleFinalResponseMemory } from "../long-term-memory/finalization.js";
import { parseRootAuthoredResponse } from "../orchestration/final-response/authoring-contract.js";
import { runRequestRunner } from "../request/runner.js";
import { createMemoryRecallHarness, modelMessages, responseDecision, type RecallPolicy } from "./support/memory-recall-runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

const REFERENCE_KIND = "conversation_memory_authoring_reference_v1";
const KNOWLEDGE: LearningKnowledgeContext = {
  kind: "learning_knowledge_reference_v1", authority: "passive_reference",
  presenceEffect: "does_not_authorize_actions_or_add_user_intent",
  repositoryRevision: 12, knowledgeRevision: 7, omitted: 4,
  referenceTime: "2026-09-26T10:00:00.000Z",
  entries: [
    { kind: "candidate", id: "canonical-candidate", version: "3", content: "Prefers concise explanations.", tags: ["style"], score: 65, reason: "Prior support", certainty: "observed", mutable: true, lastReinforcedAt: null, reconsiderAt: null },
    { kind: "memory", id: "protected-memory", version: "old-version", content: "A manually edited preference.", tags: [], score: null, reason: null, certainty: "observed", mutable: false, lastReinforcedAt: null, reconsiderAt: null },
  ],
};
const PROPOSAL = { content: "Prefers brief explanations with examples.", tags: ["style"], target: "k1", score: 93, reason: "The current message independently confirms the preference.", reinforced: true };

function fixture(policy: RecallPolicy = "supervisor-worker-v1") {
  const harness = createMemoryRecallHarness({ policy, decide: () => responseDecision(policy) });
  const prepare = vi.fn(async () => structuredClone(KNOWLEDGE));
  const learning: LearningMemoryService = {
    prepare, policy: vi.fn(), configurePolicy: vi.fn(), reviewAdmission: vi.fn(),
    nextReconsiderationAt: vi.fn(), reconsiderationContext: vi.fn(), maintenance: vi.fn(),
    nextExpiryAt: vi.fn(), overview: vi.fn(), sourceVersions: vi.fn(), apply: vi.fn(), list: vi.fn(), receipt: vi.fn(),
  };
  const memory = { ...harness.memory, learning };
  const request = deriveTestRequestExecutionScope(harness.request, { longTermMemory: memory });
  return { ...harness, request, memory, prepare };
}

describe("shared conversation memory authoring", () => {
  test("binds current request evidence and resolves detached exact targets without exposing identifiers", async () => {
    const f = fixture();
    const steering = { version: 1, updates: [{ sequence: 1, steerId: "s1", text: "Keep examples short too." }] };
    const context = await prepareConversationMemoryAuthoring(f.request, steering);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(context?.evidence.observedAt).toBe(KNOWLEDGE.referenceTime);
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ query: `${f.request.prompt}\nKeep examples short too.` }));
    expect(context?.evidence.evidenceDigest).toBe(createHash("sha256").update(JSON.stringify([f.request.prompt, steering.updates[0]!.text])).digest("hex"));
    const capsule = JSON.parse(context!.message.content);
    expect(capsule).toMatchObject({ kind: REFERENCE_KIND, applicability: "memoryCandidates_only", omitted: 4 });
    expect(capsule.entries[0]).toMatchObject({ ref: "k1", content: KNOWLEDGE.entries[0]!.content });
    expect(capsule.entries[0]).not.toHaveProperty("id");
    expect(capsule.entries[0]).not.toHaveProperty("version");
    const candidates = parseConversationMemoryCandidates([{ ...PROPOSAL, assessment: { evidence: { sourceSessionId: "forged" } } }], context);
    expect(candidates[0]?.assessment).toMatchObject({ score: 93, evidence: { sourceSessionId: f.request.sessionId, sourceRequestId: f.request.requestId }, target: KNOWLEDGE.entries[0] });
    expect(candidates[0]?.assessment?.target).not.toBe(KNOWLEDGE.entries[0]);
  });

  test.each([-48, 48])("admits authoring evidence with a memory clock %i hours from wall time", async (offsetHours) => {
    const timestamp = Date.now() + offsetHours * 60 * 60 * 1000;
    const f = authoringMemoryFixture(timestamp);
    const context = await prepareConversationMemoryAuthoring(f.request, { version: 0, updates: [] });
    expect(context?.evidence.observedAt).toBe(new Date(timestamp).toISOString());
    const candidates = parseConversationMemoryCandidates([{ ...PROPOSAL, target: null }], context);
    const result = await f.memory.processCandidates({ candidates, context: f.request });
    expect(result).toMatchObject({ available: true, acceptedCount: 1 });
    const snapshot = await f.repository.read();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.learningCandidates).toHaveLength(1);
    expect(snapshot.learningCandidates?.[0]?.sources[0]).toMatchObject({
      kind: "passive_response", observedAt: context!.evidence.observedAt,
      sourceSessionId: f.request.sessionId, sourceRequestId: f.request.requestId,
    });
    expect(snapshot.learningCandidates?.[0]?.reinforcements).toHaveLength(1);
  });

  test("saves a direct user request as protected memory without candidate admission", async () => {
    const prompt = "Please remember that I prefer brief explanations.";
    const f = authoringMemoryFixture(Date.now(), prompt);
    const context = await prepareConversationMemoryAuthoring(f.request, { version: 0, updates: [] });
    const candidates = parseConversationMemoryCandidates([{
      ...PROPOSAL, content: "I prefer brief explanations.", target: null,
      explicitRequestQuote: prompt,
    }], context);
    expect(candidates[0]?.assessment?.explicitlyRequested).toBe(true);
    const result = await f.memory.processCandidates({ candidates, context: f.request });
    expect(result).toMatchObject({ available: true, acceptedCount: 1 });
    const snapshot = await f.repository.read();
    expect(snapshot.learningCandidates).toEqual([]);
    expect(snapshot.records).toMatchObject([{
      content: "I prefer brief explanations.", automaticManagement: "protected",
      provenance: { kind: "manual", source: "management_api" },
    }]);
    expect(f.embed).toHaveBeenCalledOnce();
  });

  test("only a quote from this request can bypass candidate maturation", async () => {
    const f = authoringMemoryFixture(Date.now(), "I prefer brief explanations.");
    const context = await prepareConversationMemoryAuthoring(f.request, { version: 0, updates: [] });
    const proposal = { ...PROPOSAL, target: null, explicitRequestQuote: "Please remember that I prefer brief explanations." };
    expect(parseConversationMemoryCandidates([proposal], context)).toEqual([]);
    const candidates = parseConversationMemoryCandidates([{ ...proposal, explicitRequestQuote: null }], context);
    const result = await f.memory.processCandidates({ candidates, context: f.request });
    expect(result).toMatchObject({ available: true, acceptedCount: 1 });
    const snapshot = await f.repository.read();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.learningCandidates).toHaveLength(1);
  });

  test("a direct request wins over an ordinary duplicate in the same authoring result", async () => {
    const prompt = "Remember that I prefer brief explanations.";
    const f = authoringMemoryFixture(Date.now(), prompt);
    const context = await prepareConversationMemoryAuthoring(f.request, { version: 0, updates: [] });
    const ordinary = { ...PROPOSAL, content: "I prefer brief explanations.", target: null, explicitRequestQuote: null };
    const candidates = parseConversationMemoryCandidates([ordinary, { ...ordinary, explicitRequestQuote: prompt }], context);
    const result = await f.memory.processCandidates({ candidates, context: f.request });
    expect(result).toMatchObject({ acceptedCount: 1, duplicateCount: 1 });
    const snapshot = await f.repository.read();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.learningCandidates).toEqual([]);
  });

  test("an explicit request protects an already stored automatic fact without duplicating it", async () => {
    const prompt = "Remember that I prefer brief explanations.";
    const f = authoringMemoryFixture(Date.now(), prompt);
    const created = await f.memory.create({ content: "I prefer brief explanations.", tags: ["style"], source: "management_api",
      context: { abortSignal: f.request.abortSignal } });
    await f.repository.update((snapshot) => ({ ...snapshot, records: snapshot.records.map((record) => record.id === created.record.id
      ? { ...record, provenance: { kind: "passive_response" as const, sourceSessionId: "earlier-session", sourceRequestId: "earlier-request" }, automaticManagement: "allowed" as const }
      : record) }));
    const context = await prepareConversationMemoryAuthoring(f.request, { version: 0, updates: [] });
    const candidates = parseConversationMemoryCandidates([{
      ...PROPOSAL, content: "I prefer brief explanations.", target: null, explicitRequestQuote: prompt,
    }], context);
    const result = await f.memory.processCandidates({ candidates, context: f.request });
    expect(result).toMatchObject({ available: true, acceptedCount: 1 });
    const snapshot = await f.repository.read();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({ id: created.record.id, automaticManagement: "protected" });
  });

  test.each([
    { state: "future", elapsed: -1 },
    { state: "expired", elapsed: 86_400_000 },
  ])("rejects $state evidence at candidate processing without writing or embedding", async ({ elapsed }) => {
    const f = authoringMemoryFixture(Date.now());
    const context = await prepareConversationMemoryAuthoring(f.request, { version: 0, updates: [] });
    const candidates = parseConversationMemoryCandidates([{ ...PROPOSAL, target: null }], context);
    f.advance(elapsed);
    const before = await f.repository.read();
    const result = await f.memory.processCandidates({ candidates, context: f.request });
    expect(result).toMatchObject({ available: false, acceptedCount: 0, rejectedCount: 1 });
    expect(await f.repository.read()).toEqual(before);
    expect(f.embed).not.toHaveBeenCalled();
  });

  test("rejects unknown/protected targets and unassessed proposals without sacrificing the answer", async () => {
    const f = fixture();
    const context = await prepareConversationMemoryAuthoring(f.request, { version: 0, updates: [] });
    const result = parseRootAuthoredResponse(JSON.stringify({ finalResponse: "Complete answer", memoryCandidates: [
      { ...PROPOSAL, target: "missing" }, { ...PROPOSAL, target: "k2" },
      { content: "Unassessed", tags: [] }, { ...PROPOSAL, score: 101 },
      { ...PROPOSAL, target: null, content: "Explicit new fact" },
    ] }), { memoryAuthoringContext: context });
    expect(result).toMatchObject({ ok: true, decision: { finalResponse: "Complete answer", memoryCandidates: [{ content: "Explicit new fact", assessment: { score: 93 } }] } });
    if (result.ok) expect(result.decision.memoryCandidates[0]?.assessment).not.toHaveProperty("target");
    expect(parseConversationMemoryCandidates(Array.from({ length: 12 }, () => PROPOSAL), context)).toHaveLength(MAX_CONVERSATION_MEMORY_CANDIDATES);
  });

  test("keeps unavailable preparation secondary and cannot fabricate assessed evidence", async () => {
    const f = fixture();
    f.prepare.mockRejectedValueOnce(new Error("embedding unavailable"));
    const context = await prepareConversationMemoryAuthoring(f.request, { version: 0, updates: [] });
    expect(context).toBeUndefined();
    expect(parseConversationMemoryCandidates([{ ...PROPOSAL, assessment: { score: 100 } }], context)).toEqual([{ content: PROPOSAL.content, tags: PROPOSAL.tags }]);
  });

  test.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])("%s carries assessment from the existing authoring call to finalization only", async (policy) => {
    const f = fixture(policy);
    f.invoke.mockImplementation(async (input) => {
      // Exercise the real local-provider schema boundary before its model call.
      toOllamaFormat(input.format);
      if (input.modelStep?.endsWith(".decision")) return { text: JSON.stringify({ decision: { ...responseDecision(policy), acknowledgement: "I will answer." } }), meta: {} };
      if (!input.format) return { text: "Complete answer", meta: {} };
      return { text: JSON.stringify({ ...(policy === "execution-agent-v1" ? { finalResponse: "Complete answer" } : {}), memoryCandidates: [PROPOSAL] }), meta: {} };
    });
    const result = await runRequestRunner(f.request);
    expect(result.output).toBe("Complete answer");
    expect(result.memoryCandidates?.[0]?.assessment).toMatchObject({ target: { id: "canonical-candidate", version: "3" }, evidence: { sourceSessionId: f.request.sessionId, sourceRequestId: f.request.requestId } });
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.invoke).toHaveBeenCalledTimes(policy === "supervisor-worker-v1" ? 3 : 2);
    for (const [input] of f.invoke.mock.calls) {
      const messages = modelMessages(input);
      expect(messages.filter(({ role, content }) => role === "user" && content === f.request.prompt)).toHaveLength(1);
      const references = messages.filter(({ content }) => content.startsWith(`{"kind":"${REFERENCE_KIND}"`));
      const isAuthoring = input.format !== undefined && input.modelStep?.endsWith(".response");
      expect(references).toHaveLength(isAuthoring ? 1 : 0);
    }
    scheduleFinalResponseMemory({ service: f.memory, candidates: result.memoryCandidates, requestId: f.request.requestId, sessionId: f.request.sessionId });
    expect(f.memory.scheduleCandidates).toHaveBeenCalledWith(expect.objectContaining({ candidates: result.memoryCandidates }));
  });

  test.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])("%s binds an explicit request in the existing response authoring call", async (policy) => {
    const f = fixture(policy);
    const prompt = "Remember that I prefer brief explanations.";
    const request = deriveTestRequestExecutionScope(f.request, { prompt });
    f.invoke.mockImplementation(async (input) => {
      if (input.modelStep?.endsWith(".decision")) return { text: JSON.stringify({ decision: { ...responseDecision(policy), acknowledgement: "I will answer." } }), meta: {} };
      if (!input.format) return { text: "Complete answer", meta: {} };
      toOllamaFormat(input.format);
      return { text: JSON.stringify({ ...(policy === "execution-agent-v1" ? { finalResponse: "Complete answer" } : {}), memoryCandidates: [{
        ...PROPOSAL, content: "I prefer brief explanations.", target: null, explicitRequestQuote: prompt,
      }] }), meta: {} };
    });
    const result = await runRequestRunner(request);
    expect(result.memoryCandidates?.[0]?.assessment?.explicitlyRequested).toBe(true);
    expect(f.invoke).toHaveBeenCalledTimes(policy === "supervisor-worker-v1" ? 3 : 2);
  });

  test.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])("%s disabled memory leaves model topology and output unchanged", async (policy) => {
    const f = fixture(policy);
    const request = deriveTestRequestExecutionScope(f.request, { longTermMemory: { ...f.memory, enabled: false } });
    f.invoke.mockImplementation(async (input) => ({
      text: input.modelStep?.endsWith(".decision") ? JSON.stringify({ decision: { ...responseDecision(policy), acknowledgement: "I will answer." } }) : "Plain answer",
      meta: {},
    }));
    const result = await runRequestRunner(request);
    expect(result.output).toBe("Plain answer");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(result.memoryCandidates).toBeUndefined();
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.invoke.mock.calls)).not.toContain(REFERENCE_KIND);
  });

  test.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])("%s skips unavailable memory authoring while preserving the response", async (policy) => {
    const f = fixture(policy);
    f.prepare.mockRejectedValue(new Error("embedding unavailable"));
    f.invoke.mockImplementation(async (input) => ({
      text: input.modelStep?.endsWith(".decision") ? JSON.stringify({ decision: { ...responseDecision(policy), acknowledgement: "I will answer." } }) : "Plain answer",
      meta: {},
    }));
    const result = await runRequestRunner(f.request);
    expect(result.output).toBe("Plain answer");
    expect(result.memoryCandidates).toBeUndefined();
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
  });

  test.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])("%s discards preparation superseded by steering before authoring", async (policy) => {
    const f = fixture(policy);
    f.prepare.mockImplementationOnce(async () => {
      f.requestSteering.append({ steerId: "new-evidence", text: "I now prefer fuller explanations." });
      return structuredClone(KNOWLEDGE);
    });
    f.invoke.mockImplementation(async (input) => {
      if (input.modelStep?.endsWith(".decision")) return { text: JSON.stringify({ decision: { ...responseDecision(policy), acknowledgement: "I will answer." } }), meta: {} };
      if (!input.format) return { text: "Updated answer", meta: {} };
      return { text: JSON.stringify({ ...(policy === "execution-agent-v1" ? { finalResponse: "Updated answer" } : {}), memoryCandidates: [{ ...PROPOSAL, content: "Prefers fuller explanations." }] }), meta: {} };
    });
    const result = await runRequestRunner(f.request);
    expect(result.output).toBe("Updated answer");
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(result.memoryCandidates?.[0]?.assessment?.evidence.evidenceDigest).toBe(createHash("sha256").update(JSON.stringify([f.request.prompt, "I now prefer fuller explanations."])).digest("hex"));
    expect(f.invoke.mock.calls.filter(([input]) => input.format && input.modelStep?.endsWith(".response"))).toHaveLength(1);
  });
});


function authoringMemoryFixture(timestamp: number, prompt = "I prefer concise explanations with examples.") {
  let time = timestamp;
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
    modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
  }));
  const memory = createLongTermMemoryService({
    repository, embeddings: { embed }, enabled: true, emitClientEvents: false,
    now: () => new Date(time),
  });
  const request = {
    longTermMemory: memory, requestId: "authoring-clock-request", sessionId: "authoring-clock-session",
    prompt, abortSignal: new AbortController().signal,
  };
  return { memory, repository, embed, request, advance: (milliseconds: number) => { time += milliseconds; } };
}
