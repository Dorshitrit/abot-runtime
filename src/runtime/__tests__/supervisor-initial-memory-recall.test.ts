import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { builtinKnowledgeSkillStore } from "../knowledge-skills/catalog.js";
import { WHAT_CAN_I_DO_SKILL } from "../knowledge-skills/builtins/what-can-i-do.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import {
  createMemoryRecallHarness, FINAL_RESPONSE, MEMORY_RECORD, modelMessages, jsonMessages,
  recallCapsules, RECALL_QUERY, REQUEST_PROMPT,
} from "./support/memory-recall-runner.js";
import { PROCEDURE_CAPABILITIES } from "./support/supervisor-procedure-orchestration-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

test.each(["found", "empty", "unavailable", "oversized"] as const)(
  "initial recall re-gates %s before responding with the full receipt", async outcome => {
    let gates = 0;
    const record = outcome === "oversized"
      ? { ...MEMORY_RECORD, content: "WHOLE_LARGE_FACT ".repeat(100) } : MEMORY_RECORD;
    const receiptOutcome = outcome === "oversized" ? "found" : outcome;
    const f = createMemoryRecallHarness({
      policy: "supervisor-worker-v1",
      classifyProcedure(input) {
        if (++gates === 1) return { requiresProcedure: true };
        const references = modelMessages(input).filter(({ role }) => role === "system").slice(1);
        expect(references).toHaveLength(1);
        expect(references[0]!.content).toContain(receiptOutcome);
        expect(references[0]!.content.length).toBeLessThanOrEqual(1_000);
        if (outcome === "found") expect(references[0]!.content).toContain(record.content);
        if (outcome === "oversized") expect(references[0]!.content).not.toContain("WHOLE_LARGE_FACT");
        expect(recallCapsules(input)).toEqual([]);
        return { requiresProcedure: false, responseRecommendation: "Answer using the lookup outcome." };
      },
      async retrieve({ query }) {
        if (query === REQUEST_PROMPT) return { available: true, records: [] };
        if (outcome === "unavailable") return { available: false, records: [], reason: "embedding_unavailable" };
        return { available: true, records: outcome === "found" || outcome === "oversized" ? [record] : [] };
      },
      delegate(input) {
        expect(JSON.stringify(input.format)).toContain('"recall_memory"');
        expect(recallCapsules(input)).toEqual([]);
        return { action: "recall_memory", query: RECALL_QUERY };
      },
      decide: () => { throw new Error("Unexpected legacy decision or child"); },
    });
    await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
    expect(f.memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual([REQUEST_PROMPT, RECALL_QUERY]);
    expect(f.getAdapters).not.toHaveBeenCalled();
    const calls = f.gatewayInvoke.mock.calls.map(([input]) => input);
    expect(calls.flatMap(input => supervisorFormatName(input) ?? [])).toEqual([
      "supervisor_presentation", "supervisor_procedure_gate", "supervisor_delegation", "supervisor_procedure_gate",
    ]);
    for (const input of calls.filter(input => input.modelStep === "supervisor.response"))
      expect(recallCapsules(input)).toEqual([expect.objectContaining({
        callId: "call-1", steeringVersion: 0,
        recalls: [expect.objectContaining({ outcome: receiptOutcome, query: RECALL_QUERY, completedChildCount: 0,
          memories: outcome === "found" || outcome === "oversized" ? [record] : [] })],
      })]);
    expect(JSON.stringify(vi.mocked(f.request.onEvent).mock.calls)).not.toContain('"name":"role.delegated"');
    expect(f.request.onAcknowledgement).toHaveBeenCalledOnce();
  },
);

test.each([true, false])("a direct answer with memory enabled=%s never requests an explicit lookup", async enabled => {
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled,
    classifyProcedure: () => ({ requiresProcedure: false, responseRecommendation: "Answer the question directly." }),
    delegate: () => { throw new Error("Unexpected delegation"); },
    decide: () => { throw new Error("Unexpected legacy routing or child"); },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual(enabled ? [REQUEST_PROMPT] : []);
  expect(f.getAdapters).not.toHaveBeenCalled();
  const calls = f.gatewayInvoke.mock.calls.map(([input]) => input);
  expect(calls.filter(input => supervisorFormatName(input) === "supervisor_procedure_gate")).toHaveLength(1);
  expect(calls.flatMap(recallCapsules)).toEqual([]);
});

test("the builtin overview still reaches direct response without adding a final-response capability catalog", async () => {
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills: () => ({ action: "read_skills", skillIds: [WHAT_CAN_I_DO_SKILL.skillId] }),
    classifyProcedure(input) {
      expect(JSON.stringify(input.messages)).not.toContain(WHAT_CAN_I_DO_SKILL.content);
      return { requiresProcedure: false, responseRecommendation: "Explain supported uses." };
    },
    decide: () => { throw new Error("Unexpected legacy routing or child"); },
  });
  const store = {
    list: vi.fn(() => builtinKnowledgeSkillStore.list()),
    read: vi.fn((skillId: string) => builtinKnowledgeSkillStore.read(skillId)),
  };
  const request = createRequestExecutionScope({
    seed: { ...f.request, prompt: "What can you do?" }, executionPolicy: f.request.executionPolicy,
    knowledgeSkillStore: store,
    createWorkerCapabilities: () => ({ getDescriptors: () => PROCEDURE_CAPABILITIES, getAdapters: f.getAdapters }),
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(store.read).toHaveBeenCalledExactlyOnceWith(WHAT_CAN_I_DO_SKILL.skillId);
  const responses = f.gatewayInvoke.mock.calls.map(([input]) => input).filter(input => input.modelStep === "supervisor.response");
  expect(responses).toHaveLength(1);
  expect(jsonMessages(responses[0]!)).toContainEqual(expect.objectContaining({
    kind: "runtime_core_skill_read_v1", document: expect.objectContaining(WHAT_CAN_I_DO_SKILL),
  }));
  expect(jsonMessages(responses[0]!)).not.toContainEqual(expect.objectContaining({ kind: "runtime_supervisor_capability_reference_v1" }));
  expect(f.memory.retrieve).not.toHaveBeenCalled();
  expect(f.getAdapters).not.toHaveBeenCalled();
});

test.each(["found", "empty", "unavailable", "oversized"] as const)(
  "a true re-gate after %s delegates once with the full receipt and no repeat recall", async outcome => {
    let delegations = 0;
    const record = outcome === "oversized" ? { ...MEMORY_RECORD, content: "oversized ".repeat(150) } : MEMORY_RECORD;
    const objective = outcome === "found" ? `Observe current state. Relevant preference: ${record.content}` : "Observe the requested current state.";
    const f = createMemoryRecallHarness({
      policy: "supervisor-worker-v1",
      memoryRecallLimit: 5,
      async retrieve({ query }) {
        if (query === REQUEST_PROMPT) return { available: true, records: [] };
        if (outcome === "unavailable") return { available: false, records: [], reason: "embedding_unavailable" };
        return { available: true, records: outcome === "empty" ? [] : [record] };
      },
      classifyProcedure: () => ({ requiresProcedure: true }),
      delegate(input) {
        if (++delegations === 1) return { action: "recall_memory", query: RECALL_QUERY };
        expect(JSON.stringify(input.format)).not.toContain('"recall_memory"');
        expect(recallCapsules(input)).toEqual([expect.objectContaining({
          recalls: [expect.objectContaining({
            outcome: outcome === "oversized" ? "found" : outcome,
            memories: outcome === "found" || outcome === "oversized" ? [record] : [],
          })],
        })]);
        return { action: "invoke_role", roleId: "worker", objective };
      },
      decide(input) {
        if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
        if (input.modelStep === "worker.decision") {
          expect(JSON.stringify(input.messages)).toContain(objective);
          return { action: "return_result" };
        }
        if (input.modelStep === "worker.result") return "The assigned observation is unavailable.";
        expect(supervisorFormatName(input)).toBe("supervisor_decision");
        expect(recallCapsules(input)).toHaveLength(1);
        // Returning from a child keeps the established global recall policy.
        expect(JSON.stringify(input.format)).toContain('"recall_memory"');
        return { action: "respond" };
      },
    });
    await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
    const calls = f.gatewayInvoke.mock.calls.map(([input]) => input);
    expect(calls.filter(input => supervisorFormatName(input) === "supervisor_procedure_gate")).toHaveLength(2);
    expect(calls.filter(input => input.modelStep === "worker.decision")).toHaveLength(1);
    expect(delegations).toBe(2);
    expect(f.memory.retrieve).toHaveBeenCalledTimes(2);
  },
);

test("a true re-gate can select Planner and preserve its completed child result", async () => {
  let delegations = 0;
  let plannerCalls = 0;
  const objective = "Prepare the requested bounded explanation.";
  const result = "The requested explanation is complete.";
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", classifyProcedure: () => ({ requiresProcedure: true }),
    delegate(input) {
      if (++delegations === 1) return { action: "recall_memory", query: RECALL_QUERY };
      expect(JSON.stringify(input.format)).not.toContain('"recall_memory"');
      expect(recallCapsules(input)).toHaveLength(1);
      return { action: "invoke_role", roleId: "planner", objective };
    },
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
      if (input.modelStep === "planner.decision") {
        if (++plannerCalls === 1) return {
          action: "invoke_role", roleId: "worker",
          plan: { summary: objective, items: [{ title: "Explain the distinction", objective }] },
          selectedItemIndexes: [0],
        };
        return { action: "return_result", result };
      }
      if (input.modelStep === "worker.decision") return { action: "return_result" };
      if (input.modelStep === "worker.result") return result;
      expect(supervisorFormatName(input)).toBe("supervisor_decision");
      expect(jsonMessages(input)).toContainEqual(expect.objectContaining({
        kind: "runtime_child_result", roleId: "planner", outcome: "completed", summary: result,
      }));
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(delegations).toBe(2);
  expect(plannerCalls).toBe(2);
  expect(f.gatewayInvoke.mock.calls.filter(([input]) => supervisorFormatName(input) === "supervisor_procedure_gate")).toHaveLength(2);
  expect(f.memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual([REQUEST_PROMPT, RECALL_QUERY]);
});

test("disabled memory does not expose recall at the initial delegation boundary", async () => {
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false,
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate(input) {
      expect(JSON.stringify(input.format)).not.toContain('"recall_memory"');
      return { action: "invoke_role", roleId: "worker", objective: "Observe the requested current state." };
    },
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
      if (input.modelStep === "worker.decision") return { action: "return_result" };
      if (input.modelStep === "worker.result") return "No external observation was available.";
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.memory.retrieve).not.toHaveBeenCalled();
});

test.each(["delegation", "retrieval"] as const)(
  "steering during initial %s prevents stale recall evidence from reaching the response", async stage => {
    let gates = 0;
    let delegated = 0;
    const steeringText = "Answer the new question without using the earlier preference.";
    const f = createMemoryRecallHarness({
      policy: "supervisor-worker-v1",
      classifyProcedure: () => ++gates === 1
        ? { requiresProcedure: true }
        : { requiresProcedure: false, responseRecommendation: "Answer the new question." },
      delegate() {
        delegated += 1;
        if (stage === "delegation")
          expect(f.requestSteering.append({ steerId: "supersede-recall", text: steeringText }).ok).toBe(true);
        return { action: "recall_memory", query: RECALL_QUERY };
      },
      async retrieve({ query }) {
        if (query === REQUEST_PROMPT) return { available: true, records: [] };
        expect(stage).toBe("retrieval");
        expect(f.requestSteering.append({ steerId: "supersede-recall", text: steeringText }).ok).toBe(true);
        return { available: true, records: [MEMORY_RECORD] };
      },
      decide: () => { throw new Error("Unexpected legacy decision or child"); },
    });
    await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
    expect(gates).toBe(2);
    expect(delegated).toBe(1);
    expect(f.memory.retrieve.mock.calls.map(([input]) => input.query))
      .toEqual(stage === "delegation" ? [REQUEST_PROMPT] : [REQUEST_PROMPT, RECALL_QUERY]);
    expect(f.getAdapters).not.toHaveBeenCalled();
    const responses = f.gatewayInvoke.mock.calls.map(([input]) => input)
      .filter(input => input.modelStep === "supervisor.response");
    for (const input of responses) {
      expect(recallCapsules(input)).toEqual([]);
      expect(JSON.stringify(modelMessages(input))).not.toContain(MEMORY_RECORD.content);
      expect(JSON.stringify(modelMessages(input))).toContain(steeringText);
    }
  },
);
