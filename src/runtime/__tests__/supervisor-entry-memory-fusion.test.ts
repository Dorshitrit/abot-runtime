import { createHash } from "node:crypto";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { scheduleFinalResponseMemory } from "../long-term-memory/finalization.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import { createSupervisorEntryMemoryFormat, parseSupervisorEntryMemoryOutput } from "../steps/supervisor-decision/entry-memory-contract.js";
import { createFusedSupervisorEntryFormat } from "../steps/supervisor-decision/fused-contracts.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { defaultSupervisorPresentation } from "./support/supervisor-model-phases.js";
import {
  createSupervisorMemoryFusionFixture, MEMORY_KNOWLEDGE, MEMORY_PROPOSAL,
  memoryFusionCapsules, memoryFusionFormat, RAW_ANSWER,
} from "./support/supervisor-memory-fusion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const ENTRY_MEMORY = "supervisor_fused_entry_with_memory_candidates";
const MEMORY_REFERENCE = "conversation_memory_authoring_reference_v1";
const presentation = { includeAcknowledgement: false, includeTitle: false };
const priorTurn = [
  { id: "prior-user", role: "user" as const, content: "Explain the supplied convention.", requestId: "prior", createdAt: "2026-11-23T10:00:00Z" },
  { id: "prior-assistant", role: "assistant" as const, content: "The convention uses two brief paragraphs.", requestId: "prior", createdAt: "2026-11-23T10:00:01Z" },
];

function phases(f: ReturnType<typeof createSupervisorMemoryFusionFixture>) {
  return f.invoke.mock.calls.map(([input]) => memoryFusionFormat(input) ?? input.modelStep);
}

test("complete one-turn context yields one entry/memory call and separate RAW with bound targets", async () => {
  const f = createSupervisorMemoryFusionFixture({ greeting: true });
  const prompt = "Hello. I prefer concise answers.";
  const request = deriveTestRequestExecutionScope(f.request, { prompt, historyMessages: priorTurn });
  const result = await runRequestRunner(request);
  expect(result.output).toBe(RAW_ANSWER);
  expect(phases(f)).toEqual([ENTRY_MEMORY, "supervisor.response"]);
  const [entry, raw] = f.invoke.mock.calls.map(([input]) => input);
  for (const input of [entry!, raw!]) {
    const messages = input.messages as readonly ChatMessage[];
    for (const content of [prompt, ...priorTurn.map(message => message.content)])
      expect(messages.filter(message => message.content === content)).toHaveLength(1);
    expect(messages.filter(message => message.role === "user" && message.content === prompt)).toHaveLength(1);
  }
  expect(memoryFusionCapsules(entry!, MEMORY_REFERENCE)).toMatchObject([{ omitted: 0, entries: [
    { ref: "k1", content: MEMORY_KNOWLEDGE.entries[0]!.content, mutable: true },
    { ref: "k2", content: MEMORY_KNOWLEDGE.entries[1]!.content, mutable: false },
  ] }]);
  expect(memoryFusionCapsules(raw!, MEMORY_REFERENCE)).toEqual([]);
  expect(raw).not.toHaveProperty("format");
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(result.memoryCandidates).toMatchObject([{ content: MEMORY_PROPOSAL.content, assessment: {
    target: MEMORY_KNOWLEDGE.entries[0], evidence: {
      sourceRequestId: request.requestId, sourceSessionId: request.sessionId,
      evidenceDigest: createHash("sha256").update(JSON.stringify([prompt])).digest("hex"),
    },
  } }]);
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
  scheduleFinalResponseMemory({ service: f.memory, candidates: result.memoryCandidates,
    requestId: request.requestId, sessionId: request.sessionId });
  expect(f.memory.scheduleCandidates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ candidates: result.memoryCandidates }));
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(RAW_ANSWER);
});

test("malformed candidates preserve the accepted direct answer without repair or separate authoring", async () => {
  const f = createSupervisorMemoryFusionFixture({ greeting: true, candidates: "invalid-memory-channel" });
  expect(await runRequestRunner(f.request)).toEqual({ output: RAW_ANSWER });
  expect(phases(f)).toEqual([ENTRY_MEMORY, "supervisor.response"]);
  expect(f.memory.scheduleCandidates).not.toHaveBeenCalled();
  const missing = parseSupervisorEntryMemoryOutput(JSON.stringify({ decision: {
    requiresProcedure: false, responseRecommendation: "Greet the user.",
  } }), [], presentation);
  expect(missing).toMatchObject({ ok: true, decision: { gate: { requiresProcedure: false }, memoryCandidates: [] } });
});

test.each([{ requiresProcedure: true }, { action: "read_skills", skillIds: ["guidance"] }])(
  "non-response entry %j retains its original contract and cannot carry memory candidates", decision => {
    const base = createFusedSupervisorEntryFormat(["guidance"], presentation);
    const original = structuredClone(base);
    const format = createSupervisorEntryMemoryFormat(base);
    expect(base).toEqual(original);
    expect(validateJsonSchemaValue(format, { decision })).toBeUndefined();
    const parsed = parseSupervisorEntryMemoryOutput(JSON.stringify({ decision }), ["guidance"], presentation);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("Expected the original entry branch");
    expect(parsed.decision).not.toHaveProperty("memoryCandidates");
    const contaminated = { ...decision, memoryCandidates: [MEMORY_PROPOSAL] };
    expect(validateJsonSchemaValue(format, { decision: contaminated })).toBeDefined();
    expect(parseSupervisorEntryMemoryOutput(JSON.stringify({ decision: contaminated }), ["guidance"], presentation).ok).toBe(false);
    expect(validateJsonSchemaValue(format, { decision: { requiresProcedure: false, responseRecommendation: "Greet." } })).toBeDefined();
  },
);

test("a different response calibration keeps entry, separate memory authoring and RAW", async () => {
  const f = createSupervisorMemoryFusionFixture({ greeting: true });
  const profile = f.request.modelPolicy!.profiles!.test!;
  const request = deriveTestRequestExecutionScope(f.request, { modelPolicy: {
    ...f.request.modelPolicy!, profiles: { test: { ...profile,
      calibration: { "supervisor.response": { generation: { temperature: 0.9 } } },
    } },
  } });
  const result = await runRequestRunner(request);
  expect(result.output).toBe(RAW_ANSWER);
  expect(result.memoryCandidates).toHaveLength(1);
  expect(phases(f)).toEqual(["supervisor_fused_entry", "supervisor_memory_candidates", "supervisor.response"]);
  expect(f.prepare).toHaveBeenCalledOnce();
});

test("measured pressure falls back before dispatch without consuming the original entry", async () => {
  const f = createSupervisorMemoryFusionFixture({ greeting: true });
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async input => {
    const invocation = resolveModelInvocation(input);
    return { inputTokens: memoryFusionFormat(input) === ENTRY_MEMORY ? 25_000 : 1_000,
      profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const request = deriveTestRequestExecutionScope(f.request, {
    modelGatewayClient: { ...f.request.modelGatewayClient, countInputTokens },
  });
  expect((await runRequestRunner(request)).output).toBe(RAW_ANSWER);
  expect(countInputTokens.mock.calls.some(([input]) => memoryFusionFormat(input) === ENTRY_MEMORY)).toBe(true);
  expect(phases(f)).toEqual(["supervisor_fused_entry", "supervisor_memory_candidates", "supervisor.response"]);
  expect(f.prepare).toHaveBeenCalledTimes(2);
});

test("two settled turns retain full separate authoring instead of enlarging the compact entry", async () => {
  const f = createSupervisorMemoryFusionFixture({ greeting: true });
  const oldest = [
    { ...priorTurn[0]!, id: "old-user", requestId: "old", content: "EARLIER_USER_FACT" },
    { ...priorTurn[1]!, id: "old-assistant", requestId: "old", content: "EARLIER_ASSISTANT_FACT" },
  ];
  const request = deriveTestRequestExecutionScope(f.request, { historyMessages: [...oldest, ...priorTurn] });
  expect((await runRequestRunner(request)).output).toBe(RAW_ANSWER);
  expect(phases(f)).toEqual(["supervisor_fused_entry", "supervisor_memory_candidates", "supervisor.response"]);
  const calls = f.invoke.mock.calls.map(([input]) => input);
  expect(JSON.stringify(calls[0]!.messages)).not.toContain(oldest[0]!.content);
  for (const input of calls.slice(1)) {
    const messages = input.messages as readonly ChatMessage[];
    for (const message of [...oldest, ...priorTurn])
      expect(messages.filter(item => item.content === message.content)).toHaveLength(1);
    expect(messages.filter(message => message.role === "user" && message.content === request.prompt)).toHaveLength(1);
  }
  expect(f.prepare).toHaveBeenCalledOnce();
});

test("steering invalidates the first candidate and binds accepted memory before RAW", async () => {
  const f = createSupervisorMemoryFusionFixture({ greeting: true });
  const original = f.invoke.getMockImplementation()!;
  const steering = "Remember that I prefer detailed answers now.";
  let entryCalls = 0;
  f.invoke.mockImplementation(async input => {
    if (memoryFusionFormat(input) !== ENTRY_MEMORY) return original(input);
    entryCalls += 1;
    if (entryCalls === 1) f.requestSteering.append({ steerId: "change", text: steering });
    return { text: JSON.stringify({ decision: {
      requiresProcedure: false, responseRecommendation: "Acknowledge the current preference.",
      ...defaultSupervisorPresentation(input), memoryCandidates: [{ ...MEMORY_PROPOSAL,
        content: entryCalls === 1 ? "STALE_ENTRY_CANDIDATE" : "The user prefers detailed answers.",
        explicitRequestQuote: entryCalls === 1 ? null : steering,
      }],
    } }), meta: {} };
  });
  const result = await runRequestRunner(f.request);
  expect(result.output).toBe(RAW_ANSWER);
  expect(phases(f)).toEqual([ENTRY_MEMORY, ENTRY_MEMORY, "supervisor.response"]);
  expect(JSON.stringify(result)).not.toContain("STALE_ENTRY_CANDIDATE");
  expect(result.memoryCandidates).toMatchObject([{ content: "The user prefers detailed answers.", assessment: {
    target: MEMORY_KNOWLEDGE.entries[0], explicitlyRequested: true,
    evidence: { evidenceDigest: createHash("sha256").update(JSON.stringify([f.request.prompt, steering])).digest("hex") },
  } }]);
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.invoke.mock.calls.at(-1)![0].messages)).toContain(steering);
});
