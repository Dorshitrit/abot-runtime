import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage, ModelGatewayAttachment } from "../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { runRequestRunner } from "../request/runner.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import type { LearningKnowledgeContext } from "../long-term-memory/maturation/contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRoleCallLedger, resolveRoleCallTransactions } from "../orchestration/role-calls/index.js";
import { hasInitialMemoryContext } from "../orchestration/role-calls/memory-recall-state-validation.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { captureApprovalSnapshotData } from "../request/approval-wait/snapshot-data.js";
import { prepareInitialMemory, projectExecutionAgentMemory } from "../long-term-memory/initial-context.js";
import { createMemoryRecallHarness } from "./support/memory-recall-runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetDebugLoggerConfig(); });

const knowledge: LearningKnowledgeContext = {
  kind: "learning_knowledge_reference_v1", authority: "passive_reference",
  presenceEffect: "does_not_authorize_actions_or_add_user_intent",
  repositoryRevision: 2, knowledgeRevision: 2, omitted: 0,
  referenceTime: "2026-10-12T10:00:00.000Z", entries: [{
    kind: "memory", id: "units", version: "2026-10-11T10:00:00.000Z",
    content: "The user prefers metric units.", tags: ["units"], mutable: true,
    score: null, reason: null, certainty: "unspecified", lastReinforcedAt: null, reconsiderAt: null,
  }],
};

function fixture() {
  const harness = createMemoryRecallHarness({ policy: "execution-agent-v1", decide: () => ({ action: "respond" }) });
  const baseMemory = createLongTermMemoryService({
    enabled: true, repository: createInMemoryLongTermMemoryRepository(), emitClientEvents: false,
    embeddings: { embed: vi.fn(async ({ texts }) => ({ modelFingerprint: "initial", dimensions: 2,
      vectors: texts.map(() => [1, 0]) })) },
  });
  const retrieve = vi.fn<typeof baseMemory.retrieve>().mockResolvedValue({
    available: true, records: [], message: { role: "system", content: "Stored units reference" },
  });
  const prepare = vi.fn<NonNullable<typeof baseMemory.learning>["prepare"]>().mockResolvedValue(knowledge);
  const memory = { ...baseMemory, retrieve, learning: { ...baseMemory.learning!, prepare } };
  const request = deriveTestRequestExecutionScope(harness.request, { longTermMemory: memory });
  return { ...harness, request, memory, retrieve, prepare };
}

test("startup reference is passive ledger state, not a recall or an activation", async () => {
  const f = fixture();
  const initialMemory = await prepareInitialMemory(f.request);
  const ledger = createRoleCallLedger({ requestId: f.request.requestId,
    policy: createRequestRoleCallPolicy(f.request.executionPolicy), initialMemory });
  const created = await resolveRoleCallTransactions(ledger).createRoot({ expectedHead: ledger.current() });
  expect(created.ok).toBe(true);
  expect(ledger.current().revision).toBe(1);
  expect(ledger.current().state.memoryRecalls).toEqual([]);
  expect(ledger.current().state.calls[0]!.activationCount).toBe(1);
  expect(ledger.current().state.initialMemory).toEqual(initialMemory);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("serialized initial targets rebind current user evidence without another lookup on later steering", async () => {
  const f = fixture();
  const initial = await prepareInitialMemory(f.request);
  const saved = JSON.parse(JSON.stringify(initial));
  f.requestSteering.append({ steerId: "units", text: "Remember that I prefer kilometres." });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
  expect(await prepareInitialMemory(f.request, saved)).toEqual(saved);
  const projected = projectExecutionAgentMemory(f.request, saved, f.requestSteering.snapshot());
  expect(projected.memoryMessage).toEqual(initial!.message);
  expect(projected.authoringContext!.evidence.observedAt).toBe("2026-10-15T10:00:00.000Z");
  expect(projected.authoringContext!.userMessages).toEqual([f.request.prompt, "Remember that I prefer kilometres."]);
  expect(projected.authoringContext!.targets.get("k1")).toEqual(knowledge.entries[0]);
  const shown = JSON.parse(projected.authoringContext!.message.content).entries;
  expect(shown).toEqual([expect.objectContaining({ ref: "k1", content: knowledge.entries[0]!.content })]);
  expect(shown[0]).not.toHaveProperty("id");
  expect(f.retrieve).toHaveBeenCalledOnce(); expect(f.prepare).toHaveBeenCalledOnce();
});

test.each(["empty", "unavailable"] as const)("%s startup results remain prepared without retry", async outcome => {
  const f = fixture();
  f.retrieve.mockResolvedValue({ available: outcome === "empty", records: [] });
  f.prepare.mockRejectedValue(new Error("learning_unavailable"));
  const initial = await prepareInitialMemory(f.request);
  expect(initial).toEqual({});
  expect(await prepareInitialMemory(f.request, JSON.parse(JSON.stringify(initial)))).toEqual({});
  expect(projectExecutionAgentMemory(f.request, initial, f.requestSteering.snapshot()).authoringEnabled).toBe(false);
  expect(f.retrieve).toHaveBeenCalledOnce(); expect(f.prepare).toHaveBeenCalledOnce();
});

test.each(["supervisor-worker-v1", "execution-agent-v1"] as const)("%s skips disabled startup memory", async policy => {
  const f = createMemoryRecallHarness({ policy, enabled: false, decide: () => ({ action: "respond" }) });
  expect(await prepareInitialMemory(f.request)).toBeUndefined();
  expect(f.memory.retrieve).not.toHaveBeenCalled();
});

test("restored knowledge has one canonical target representation and rejects malformed data", () => {
  expect(hasInitialMemoryContext({ knowledge }, "execution-agent-v1")).toBe(true);
  expect(hasInitialMemoryContext(undefined, "execution-agent-v1")).toBe(true);
  expect(hasInitialMemoryContext({ knowledge }, "supervisor-worker-v1")).toBe(true);
  expect(hasInitialMemoryContext({ message: { role: "developer", content: "Unsupported role" } }, "execution-agent-v1")).toBe(false);
  expect(hasInitialMemoryContext({ knowledge: { ...knowledge, entries: [...knowledge.entries, ...knowledge.entries] } }, "execution-agent-v1")).toBe(false);
  expect(hasInitialMemoryContext({ knowledge: { ...knowledge, entries: [{ ...knowledge.entries[0], version: "" }] } }, "execution-agent-v1")).toBe(false);
});

test.each(["candidate", "memory"] as const)("restored %s entries filter unknown fields without rejecting the request", async kind => {
  const f = fixture();
  const entry = { ...knowledge.entries[0]!, kind };
  const saved = JSON.parse(JSON.stringify({ knowledge: {
    ...knowledge, entries: [{ ...entry, extraInstruction: "untrusted-extra", ref: "forged-ref" }],
  } }));
  expect(hasInitialMemoryContext(saved, "execution-agent-v1")).toBe(true);
  const restored = await prepareInitialMemory(f.request, saved);
  const projected = projectExecutionAgentMemory(f.request, restored, f.requestSteering.snapshot());
  expect(projected.authoringContext!.targets.get("k1")).toEqual(entry);
  const shown = JSON.parse(projected.authoringContext!.message.content).entries[0];
  expect(shown).toMatchObject({ ref: "k1", content: entry.content, tags: entry.tags });
  expect(shown).not.toHaveProperty("extraInstruction");
  expect(projected.authoringContext!.message.content).not.toContain("forged-ref");
  expect(saved.knowledge.entries[0].extraInstruction).toBe("untrusted-extra");
  expect(f.retrieve).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
});

test.each(["direct", "deferred"])("%s authoring ignores extra knowledge fields and completes", async route => {
  const f = fixture();
  f.prepare.mockResolvedValue({ ...knowledge, entries: [
    { ...knowledge.entries[0]!, ...{ extraInstruction: "untrusted-extra", ref: "forged-ref" } },
  ] });
  f.invoke.mockImplementation(async input => {
    const messages = input.messages as readonly ChatMessage[];
    expect(JSON.stringify(messages)).not.toContain("untrusted-extra");
    expect(JSON.stringify(messages)).not.toContain("forged-ref");
    expect(JSON.stringify(messages)).toContain(knowledge.entries[0]!.content);
    if (input.modelStep === "execution.response")
      return { text: JSON.stringify({ finalResponse: "Complete answer.", memoryCandidates: [] }), meta: {} };
    return { text: JSON.stringify({ decision: {
      action: "respond",
      ...(route === "direct" ? { response: "Complete answer.", memoryCandidates: [] } : {}),
    } }), meta: {} };
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: "Complete answer." });
  expect(f.invoke).toHaveBeenCalledTimes(route === "direct" ? 1 : 2);
  expect(f.retrieve).toHaveBeenCalledOnce();
});

test.each(["date", "function", "cycle"])("startup drops unknown %s fields before ledger and approval serialization", async kind => {
  const f = fixture();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const extra = { date: new Date(), function: () => {}, cycle }[kind];
  const source = { ...knowledge, extra, entries: [{ ...knowledge.entries[0]!, extra }] };
  f.prepare.mockResolvedValue(source);
  const initialMemory = await prepareInitialMemory(f.request);
  expect(initialMemory!.knowledge).toEqual(knowledge);
  const ledger = createRoleCallLedger({ requestId: f.request.requestId,
    policy: createRequestRoleCallPolicy(f.request.executionPolicy), initialMemory });
  expect(captureApprovalSnapshotData(ledger.current().state).initialMemory?.knowledge).toEqual(knowledge);
  expect(source.extra).toBe(extra);
  expect(source.entries[0]!.extra).toBe(extra);
});

const memoryAttachment: ModelGatewayAttachment = {
  id: "stored-image", kind: "image", mimeType: "image/png",
  storageRef: "memory/stored-image.png", name: "stored-image.png", size: 3, data: "YWJj",
};

test.each(["system", "user", "assistant", "tool"] as const)("%s memory drops request-local tool attachments but preserves regular attachments", async role => {
  const f = fixture();
  const ephemeral = { ...memoryAttachment, id: "tool-image", data: "PRIVATE_PIXELS",
    toolEvidence: { executionId: "prior-execution" } };
  const message: ChatMessage = role === "tool"
    ? { role, content: "Stored reference", toolCallId: "recall", toolName: "recall", attachments: [ephemeral, memoryAttachment] }
    : { role, content: "Stored reference", attachments: [ephemeral, memoryAttachment] };
  f.retrieve.mockResolvedValue({ available: true, records: [], message });
  const initial = await prepareInitialMemory(f.request);
  expect(initial!.message).toEqual({ ...message, attachments: [memoryAttachment] });
  expect(JSON.stringify(captureApprovalSnapshotData(initial))).not.toContain("PRIVATE_PIXELS");
  expect(message.attachments).toEqual([ephemeral, memoryAttachment]);
});
const textMemoryMessages: ChatMessage[] = ["system", "user", "assistant"].flatMap(role =>
  [undefined, [], [memoryAttachment]].map(attachments => ({
    role: role as "system" | "user" | "assistant", content: "Stored custom reference",
    ...(attachments !== undefined ? { attachments } : {}),
  })),
);
const toolMemoryMessages: ChatMessage[] = [
  { role: "assistant", content: "", toolCalls: [{ callId: "recall", name: "recall", arguments: "{}" }] },
  { role: "tool", content: "Stored reference", toolCallId: "recall", toolName: "recall" },
];

test.each([...textMemoryMessages, ...toolMemoryMessages])("retains the existing ChatMessage shape through ledger serialization: %j", async message => {
  const f = fixture();
  f.retrieve.mockResolvedValue({ available: true, records: [], message });
  const initialMemory = await prepareInitialMemory(f.request);
  const ledger = createRoleCallLedger({ requestId: f.request.requestId,
    policy: createRequestRoleCallPolicy(f.request.executionPolicy), initialMemory });
  const created = await resolveRoleCallTransactions(ledger).createRoot({ expectedHead: ledger.current() });
  expect(created.ok).toBe(true);
  const saved = JSON.parse(JSON.stringify(ledger.current().state.initialMemory));
  expect(hasInitialMemoryContext(saved, "execution-agent-v1")).toBe(true);
  expect(await prepareInitialMemory(f.request, saved)).toEqual(initialMemory);
  expect(projectExecutionAgentMemory(f.request, saved, f.requestSteering.snapshot()).memoryMessage).toEqual(message);
  expect(f.retrieve).toHaveBeenCalledOnce();
  expect(f.prepare).toHaveBeenCalledOnce();
});

test.each(["direct", "deferred"])("%s answers preserve custom text roles and attachments without another retrieval", async route => {
  for (const message of textMemoryMessages) {
    const harness = createMemoryRecallHarness({ policy: "execution-agent-v1",
      retrieve: async () => ({ available: true, records: [], message }),
      decide: () => route === "direct"
        ? { action: "respond", response: "Complete answer.", memoryCandidates: [] }
        : { action: "respond" },
    });
    await runRequestRunner(harness.request);
    expect(harness.invoke).toHaveBeenCalledTimes(route === "direct" ? 1 : 2);
    expect(harness.memory.retrieve).toHaveBeenCalledOnce();
    for (const [input] of harness.invoke.mock.calls) {
      const messages = input.messages as readonly ChatMessage[];
      expect(messages.filter(entry => entry.content === message.content)).toEqual([message]);
      expect(messages.filter(entry => entry.content === harness.request.prompt)).toHaveLength(1);
    }
  }
});

test.each([
  { role: "system", content: 1 },
  { role: "system", content: "Stored", extra: true },
  { role: "system", content: "Stored", attachments: {} },
  { role: "system", content: "Stored", attachments: [{ ...memoryAttachment, kind: "audio" }] },
  { role: "system", content: "Stored", attachments: [{ ...memoryAttachment, size: -1 }] },
  { role: "assistant", content: "", toolCalls: [] },
  { role: "assistant", content: "", toolCalls: [{ callId: "recall", name: "recall", arguments: "invalid" }] },
  { role: "tool", content: "Stored", toolCallId: "", toolName: "recall" },
  { role: "tool", content: "Stored", toolCallId: "recall", toolName: "invalid name" },
])("rejects malformed persisted messages: %j", message => {
  expect(hasInitialMemoryContext({ message }, "execution-agent-v1")).toBe(false);
});

test("message shape acceptance does not bypass gateway tool-call pairing", () => {
  expect(() => validateModelGatewayMessages(toolMemoryMessages)).not.toThrow();
  expect(() => validateModelGatewayMessages([toolMemoryMessages[0]])).toThrow("model_gateway_tool_result_missing");
  expect(() => validateModelGatewayMessages([toolMemoryMessages[1]])).toThrow("model_gateway_tool_result_unmatched");
});
