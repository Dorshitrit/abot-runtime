import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import {
  createMemoryRecallHarness, FINAL_RESPONSE, MEMORY_RECORD, modelMessages,
  recallCapsules, RECALL_QUERY, REQUEST_PROMPT,
} from "./support/memory-recall-runner.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

test("recall after a child with no tool results stays on evidence-aware routing", async () => {
  let routing = 0;
  const childResult = "The distinction is established; prior context may help.";
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate: () => ({ action: "invoke_role", roleId: "worker", objective: "Explain the requested distinction." }),
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
      if (input.modelStep === "worker.decision") return { action: "return_result" };
      if (input.modelStep === "worker.result") return childResult;
      expect(supervisorFormatName(input)).toBe("supervisor_decision");
      expect(JSON.stringify(input.messages)).toContain(childResult);
      if (++routing === 1) return { action: "recall_memory", query: RECALL_QUERY };
      expect(recallCapsules(input)).toEqual([expect.objectContaining({
        recalls: [expect.objectContaining({ completedChildCount: 1 })],
      })]);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.gatewayInvoke.mock.calls.filter(([input]) => supervisorFormatName(input) === "supervisor_procedure_gate")).toHaveLength(1);
  expect(routing).toBe(2);
  for (const [input] of f.gatewayInvoke.mock.calls.filter(([call]) => call.modelStep === "supervisor.response"))
    expect(JSON.stringify(input.messages)).toContain(childResult);
});

test("an initial recall still consumes the global limit on later post-child routing", async () => {
  let delegated = 0;
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", memoryRecallLimit: 1,
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate(input) {
      if (++delegated === 1) return { action: "recall_memory", query: RECALL_QUERY };
      expect(JSON.stringify(input.format)).not.toContain('"recall_memory"');
      return { action: "invoke_role", roleId: "worker", objective: "Observe the requested current state." };
    },
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
      if (input.modelStep === "worker.decision") return { action: "return_result" };
      if (input.modelStep === "worker.result") return "No external observation was available.";
      expect(supervisorFormatName(input)).toBe("supervisor_decision");
      expect(JSON.stringify(input.format)).not.toContain('"recall_memory"');
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual([REQUEST_PROMPT, RECALL_QUERY]);
});

test.each(["retrieval", "gate", "delegation"] as const)("steering during recalled %s permits one fresh lookup without leaking the old receipt", async stage => {
  let gates = 0;
  let delegations = 0;
  let steered = false;
  const newQuery = "new preference";
  const oldFact = "OLD_STEERING_FACT";
  const newFact = "NEW_STEERING_FACT";
  const steeringText = "Recall my new preference instead.";
  function steer() {
    expect(f.requestSteering.append({ steerId: "new-intent", text: steeringText }).ok).toBe(true);
    steered = true;
  }
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", memoryRecallLimit: 2,
    async retrieve({ query }) {
      if (query === REQUEST_PROMPT) return { available: true, records: [] };
      if (stage === "retrieval" && query === RECALL_QUERY) steer();
      return { available: true, records: [{ ...MEMORY_RECORD, content: query === RECALL_QUERY ? oldFact : newFact }] };
    },
    classifyProcedure(input) {
      gates += 1;
      if (gates === 2 && stage === "gate") steer();
      if (steered && gates > 2) expect(JSON.stringify(input.messages)).not.toContain(oldFact);
      if (JSON.stringify(input.messages).includes(newFact))
        return { requiresProcedure: false, responseRecommendation: "Answer the new preference." };
      return { requiresProcedure: true };
    },
    delegate(input) {
      delegations += 1;
      if (delegations === 2 && stage === "delegation") {
        expect(JSON.stringify(input.format)).not.toContain('"recall_memory"');
        steer();
        return { action: "invoke_role", roleId: "worker", objective: "Superseded task." };
      }
      expect(JSON.stringify(input.format)).toContain('"recall_memory"');
      if (steered) {
        expect(recallCapsules(input)).toEqual([]);
        expect(JSON.stringify(input.messages)).not.toContain(oldFact);
      }
      return { action: "recall_memory", query: steered ? newQuery : RECALL_QUERY };
    },
    decide: () => { throw new Error("Unexpected legacy decision or child"); },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual([REQUEST_PROMPT, RECALL_QUERY, newQuery]);
  expect(f.getAdapters).not.toHaveBeenCalled();
  for (const [input] of f.gatewayInvoke.mock.calls.filter(([call]) => call.modelStep === "supervisor.response")) {
    expect(JSON.stringify(modelMessages(input))).not.toContain(oldFact);
    expect(JSON.stringify(modelMessages(input))).toContain(newFact);
    expect(recallCapsules(input)[0]).toMatchObject({ steeringVersion: 1 });
  }
});

test("steering cannot reset a recall budget already consumed by a superseded lookup", async () => {
  let delegations = 0;
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", memoryRecallLimit: 1,
    classifyProcedure: () => ({ requiresProcedure: true }),
    async retrieve({ query }) {
      if (query === REQUEST_PROMPT) return { available: true, records: [] };
      expect(f.requestSteering.append({ steerId: "budget-steer", text: "Observe the current state instead." }).ok).toBe(true);
      return { available: true, records: [MEMORY_RECORD] };
    },
    delegate(input) {
      if (++delegations === 1) return { action: "recall_memory", query: RECALL_QUERY };
      expect(JSON.stringify(input.format)).not.toContain('"recall_memory"');
      expect(recallCapsules(input)).toEqual([]);
      return { action: "invoke_role", roleId: "worker", objective: "Observe the requested current state." };
    },
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
      if (input.modelStep === "worker.decision") return { action: "return_result" };
      if (input.modelStep === "worker.result") return "Current state remains unknown.";
      expect(supervisorFormatName(input)).toBe("supervisor_decision");
      expect(JSON.stringify(input.format)).not.toContain('"recall_memory"');
      expect(recallCapsules(input)).toEqual([]);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(delegations).toBe(2);
  expect(f.memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual([REQUEST_PROMPT, RECALL_QUERY]);
});
