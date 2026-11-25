import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toOllamaFormat } from "../../model-gateway/structured-output/ollama-format.js";
import { buildConversationMemoryAuthoringContext } from "../long-term-memory/conversation-authoring/context.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { createSupervisorMemoryRoutingFormat, parseSupervisorMemoryRoutingOutput } from "../steps/supervisor-decision/memory-fusion.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";
import { createSupervisorMemoryFusionFixture, MEMORY_KNOWLEDGE, MEMORY_PROPOSAL } from "./support/supervisor-memory-fusion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const envelope = (decision: unknown) => JSON.stringify({ decision });
const invokeWorker = { action: "invoke_role", roleId: "worker", objective: "Verify the supplied fact." };

test("adds strict candidate output only to respond and preserves other routing variants", () => {
  const base = createSupervisorDecisionFormat({ allowMemoryRecall: true });
  const original = structuredClone(base);
  const format = createSupervisorMemoryRoutingFormat(base);
  expect(base).toEqual(original);
  expect(format.strict).toBe(true);
  expect(() => toOllamaFormat(format)).not.toThrow();
  expect(validateJsonSchemaValue(format, { decision: { action: "respond", memoryCandidates: [MEMORY_PROPOSAL] } })).toBeUndefined();
  expect(validateJsonSchemaValue(format, { decision: { action: "respond" } })).toBeDefined();
  for (const decision of [invokeWorker, { action: "recall_memory", query: "saved preference" }]) {
    expect(validateJsonSchemaValue(format, { decision })).toBeUndefined();
    expect(validateJsonSchemaValue(format, { decision: { ...decision, memoryCandidates: [] } })).toBeDefined();
  }
});

test.each([undefined, "invalid", null, [{ content: 42 }]])(
  "isolates malformed candidate data while accepting the original respond: %j", memoryCandidates => {
    const parseRouting = vi.fn(parseSupervisorDecisionOutput);
    const result = parseSupervisorMemoryRoutingOutput(envelope({
      action: "respond", ...(memoryCandidates === undefined ? {} : { memoryCandidates }),
    }), parseRouting);
    expect(result).toEqual({ ok: true, decision: { decision: { action: "respond" }, memoryCandidates: [] } });
    expect(parseRouting).toHaveBeenCalledOnce();
  },
);

test("retains exact server-owned target versions and drops protected, forged and ungrounded candidates", () => {
  const f = createSupervisorMemoryFusionFixture();
  const context = buildConversationMemoryAuthoringContext(f.request, f.requestSteering.snapshot(), MEMORY_KNOWLEDGE);
  const parsed = parseSupervisorMemoryRoutingOutput(envelope({ action: "respond", memoryCandidates: [
    { ...MEMORY_PROPOSAL, assessment: { evidence: { sourceRequestId: "forged" } } },
    { ...MEMORY_PROPOSAL, target: "k2" },
    { ...MEMORY_PROPOSAL, target: "unknown" },
    { ...MEMORY_PROPOSAL, explicitRequestQuote: "Remember a preference from an old request." },
    { ...MEMORY_PROPOSAL, score: 101 },
  ] }), parseSupervisorDecisionOutput, context);
  expect(parsed).toMatchObject({ ok: true, decision: { decision: { action: "respond" }, memoryCandidates: [{
    content: MEMORY_PROPOSAL.content,
    assessment: { target: MEMORY_KNOWLEDGE.entries[0], evidence: context.evidence },
  }] } });
  if (!parsed.ok) throw new Error("Expected accepted routing");
  expect(parsed.decision.memoryCandidates).toHaveLength(1);
  expect(parsed.decision.memoryCandidates![0]!.assessment).not.toHaveProperty("explicitlyRequested");
  expect(parsed.decision.memoryCandidates![0]!.assessment!.target).not.toBe(MEMORY_KNOWLEDGE.entries[0]);
});

test("non-respond has no memory result and cannot smuggle candidate data into a routing action", () => {
  expect(parseSupervisorMemoryRoutingOutput(envelope(invokeWorker), parseSupervisorDecisionOutput))
    .toEqual({ ok: true, decision: { decision: invokeWorker } });
  const contaminated = envelope({ ...invokeWorker, memoryCandidates: [MEMORY_PROPOSAL] });
  expect(parseSupervisorMemoryRoutingOutput(contaminated, parseSupervisorDecisionOutput))
    .toEqual(parseSupervisorDecisionOutput(contaminated));
  expect(parseSupervisorDecisionOutput(contaminated).ok).toBe(false);
});

test.each(["not-json", '{"decision":{"action":"invented","memoryCandidates":[]}}',
  '{"decision":{"action":"respond","memoryCandidates":[]},"extra":true}'])(
  "does not turn invalid routing or envelope into accepted output: %s", text => {
    expect(parseSupervisorMemoryRoutingOutput(text, parseSupervisorDecisionOutput))
      .toEqual(parseSupervisorDecisionOutput(text));
    expect(parseSupervisorDecisionOutput(text).ok).toBe(false);
  },
);
