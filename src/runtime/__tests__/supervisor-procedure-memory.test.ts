import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatTextMessage } from "../../model-gateway/types.js";
import { projectLongTermMemoryMessage } from "../long-term-memory/projection.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { buildSupervisorProcedureGateInput } from "../steps/supervisor-decision/procedure-gate.js";
import { projectSupervisorProcedureMemory } from "../steps/supervisor-decision/procedure-memory.js";
import { createMemoryRecallHarness, FINAL_RESPONSE, MEMORY_RECORD, modelMessages } from "./support/memory-recall-runner.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const fact = "  The user's favorite color is blue.\nThey also like green.  ";
const message = memoryMessage(fact);
const responseDecision = { requiresProcedure: false, responseRecommendation: "Answer from the supplied relevant fact." };
const diagnostic = { requestId: "memory-recall-request", modelStep: "supervisor.decision" as const };

function memoryMessage(content: string): ChatTextMessage {
  const projected = projectLongTermMemoryMessage([{ ...MEMORY_RECORD, content }]);
  if (projected?.role !== "system") throw new Error("Expected a passive system memory message");
  return projected;
}

function changeCapsule(change: (capsule: Record<string, any>) => void): ChatTextMessage {
  const capsule = JSON.parse(message.content);
  change(capsule);
  return { role: "system", content: JSON.stringify(capsule) };
}

test("renders complete stored facts verbatim as passive readable text without metadata or JSON", () => {
  const projected = projectSupervisorProcedureMemory(message)!;
  expect(projected.message.role).toBe("system");
  expect(projected.message.content).toContain(fact);
  expect(projected.message.content.split(fact)).toHaveLength(2);
  expect(() => JSON.parse(projected.message.content)).toThrow();
  expect(projected.message.content).not.toContain("runtime_long_term_memory_reference_v1");
  expect(projected.message.content).not.toContain('"tags"');
  expect(projected.message.content).not.toContain('"memories"');
  expect(projected.message.content).not.toContain(MEMORY_RECORD.tags[0]!);
  expect(projected.message.content.length).toBeLessThanOrEqual(1_000);
  expect(message).toEqual(projectLongTermMemoryMessage([{ ...MEMORY_RECORD, content: fact }]));
});

test.each(["observed", "inferred"] as const)("preserves %s observation certainty and its exact time", certainty => {
  const observedAt = "2026-10-20T19:12:31.000Z";
  const sourceMessage = changeCapsule(capsule => {
    capsule.memories[0].source = { kind: "passive_observation", observedAt, certainty };
  });
  const projected = projectSupervisorProcedureMemory(sourceMessage)!;
  expect(projected.message.content).toContain(fact);
  expect(projected.message.content).toContain(certainty);
  expect(projected.message.content).toContain(observedAt);
  if (certainty === "inferred") expect(projected.message.content).not.toContain("certainty: observed");
});

test("admits the complete 1,000-character source and omits the whole projection at 1,001", () => {
  const empty = memoryMessage("");
  const boundary = memoryMessage("x".repeat(1_000 - empty.content.length));
  expect(boundary.content).toHaveLength(1_000);
  const projected = projectSupervisorProcedureMemory(boundary)!;
  expect(projected.message.content).toContain("x".repeat(1_000 - empty.content.length));
  expect(projected.message.content.length).toBeLessThanOrEqual(1_000);
  const oversized = { ...boundary, content: `${boundary.content} ` };
  expect(oversized.content).toHaveLength(1_001);
  expect(projectSupervisorProcedureMemory(oversized)).toBeUndefined();
});

test.each([
  ["absent", undefined],
  ["wrong role", { ...message, role: "user" }],
  ["invalid JSON", { role: "system", content: "{invalid" }],
  ["non-object", { role: "system", content: "[]" }],
  ["wrong kind", changeCapsule(c => { c.kind = "other_reference_v1"; })],
  ["wrong authority", changeCapsule(c => { c.authority = "active_assignment"; })],
  ["wrong purpose", changeCapsule(c => { c.purpose = "execute_work"; })],
  ["wrong presence", changeCapsule(c => { c.presenceEffect = "completion_evidence"; })],
  ["extra capsule field", changeCapsule(c => { c.pendingWork = "Run this"; })],
  ["no memories", changeCapsule(c => { c.memories = []; })],
  ["too many memories", changeCapsule(c => { c.memories = Array(7).fill({ content: "x", tags: [] }); })],
  ["blank fact", changeCapsule(c => { c.memories[0].content = "   "; })],
  ["non-text fact", changeCapsule(c => { c.memories[0].content = 3; })],
  ["invalid tags", changeCapsule(c => { c.memories[0].tags = [3]; })],
  ["unknown fact field", changeCapsule(c => { c.memories[0].certainty = "inferred"; })],
  ["missing observation certainty", changeCapsule(c => { c.memories[0].source = { kind: "passive_observation", observedAt: "2026-10-20" }; })],
  ["unknown observation certainty", changeCapsule(c => { c.memories[0].source = { kind: "passive_observation", observedAt: "2026-10-20", certainty: "probable" }; })],
  ["unknown observation source", changeCapsule(c => { c.memories[0].source = { kind: "external", observedAt: "2026-10-20", certainty: "inferred" }; })],
  ["missing observation time", changeCapsule(c => { c.memories[0].source = { kind: "passive_observation", certainty: "inferred" }; })],
  ["invalid later record", changeCapsule(c => { c.memories.push({ content: "valid", tags: [], source: {} }); })],
] as const)("omits the entire optional reference for %s", (_label, input) => {
  expect(projectSupervisorProcedureMemory(input)).toBeUndefined();
});

test("gate admits only the bounded readable reference while preserving schema and exact user topology", () => {
  const f = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => ({ action: "respond" }) });
  const baseline = buildSupervisorProcedureGateInput(f.request, { diagnostic });
  const enriched = buildSupervisorProcedureGateInput(f.request, { diagnostic, initialMemoryMessage: message });
  expect(enriched.format).toEqual(baseline.format);
  expect(enriched.context.selectedHistoryMessageIds).toEqual([]);
  expect(enriched.context.messages.filter(({ role }) => role === "user"))
    .toEqual([{ role: "user", content: f.request.prompt }]);
  expect(enriched.context.messages.filter(({ content }) => content.includes(fact)))
    .toEqual([projectSupervisorProcedureMemory(message)!.message]);
  expect(enriched.context.budget.parts.referenceInputTokens).toBeGreaterThan(0);
  expect(JSON.stringify(enriched.context.messages)).not.toContain("runtime_long_term_memory_reference_v1");
  expect(f.memory.retrieve).not.toHaveBeenCalled();
});

test("disabled or oversized memory leaves the complete gate input unchanged", () => {
  for (const enabled of [false, true]) {
    const f = createMemoryRecallHarness({ policy: "supervisor-worker-v1", enabled, decide: () => ({ action: "respond" }) });
    const initialMemoryMessage = enabled ? { ...message, content: message.content + " ".repeat(1_000) } : message;
    expect(buildSupervisorProcedureGateInput(f.request, { diagnostic, initialMemoryMessage }))
      .toEqual(buildSupervisorProcedureGateInput(f.request, { diagnostic }));
  }
});

test("a memory-informed false gate goes straight to response with the original full capsule", async () => {
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    retrieve: async () => ({ available: true, records: [MEMORY_RECORD], message }),
    classifyProcedure(input) {
      expect(modelMessages(input)).toContainEqual(projectSupervisorProcedureMemory(message)!.message);
      expect(modelMessages(input)).not.toContainEqual(message);
      return responseDecision;
    },
    decide: () => { throw new Error("Unexpected child or delegation"); },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.memory.retrieve).toHaveBeenCalledOnce();
  const calls = f.gatewayInvoke.mock.calls.map(([input]) => input);
  expect(calls.some(input => input.modelStep === "worker.decision")).toBe(false);
  const response = calls.find(input => input.modelStep === "supervisor.response")!;
  expect(modelMessages(response)).toContainEqual(message);
  expect(modelMessages(response)).not.toContainEqual(projectSupervisorProcedureMemory(message)!.message);
});

test("memory does not override a true gate or alter delegation and Worker context", async () => {
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    retrieve: async () => ({ available: true, records: [MEMORY_RECORD], message }),
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate(input) {
      expect(modelMessages(input)).toContainEqual(message);
      expect(modelMessages(input)).not.toContainEqual(projectSupervisorProcedureMemory(message)!.message);
      return { action: "invoke_role", roleId: "worker", objective: "Observe the requested current state." };
    },
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
      if (input.modelStep === "worker.decision") {
        expect(JSON.stringify(input.messages)).not.toContain(fact);
        return { action: "return_result" };
      }
      if (input.modelStep === "worker.result") return "The assigned observation could not be performed.";
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.gatewayInvoke.mock.calls.some(([input]) => input.modelStep === "worker.decision")).toBe(true);
  expect(f.memory.retrieve).toHaveBeenCalledOnce();
});
