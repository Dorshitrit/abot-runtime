import { workerEvidenceDecision } from "./support/worker-evidence-script.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runRequestRunner } from "../request/runner.js";
import { prepareInitialMemory } from "../long-term-memory/initial-context.js";
import { projectLongTermMemoryMessage } from "../long-term-memory/projection.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRoleCallLedger, resolveRoleCallTransactions } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import {
  createMemoryRecallHarness, FINAL_RESPONSE, MEMORY_RECORD, modelMessages,
  RECALL_QUERY, REQUEST_PROMPT, recallCapsules, responseDecision,
} from "./support/memory-recall-runner.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { vi.restoreAllMocks(); resetDebugLoggerConfig(); });

const initialMessage = projectLongTermMemoryMessage([MEMORY_RECORD])!;

function memoryHarness() {
  return createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    retrieve: async () => ({ available: true, records: [MEMORY_RECORD], message: initialMessage }),
    decide: () => ({ ...responseDecision("supervisor-worker-v1"), acknowledgement: "I will answer." }),
  });
}

test("SUPER retains startup facts for separate candidate and RAW authoring after the minimal gate", async () => {
  const f = memoryHarness();
  const baseMemory = createLongTermMemoryService({
    enabled: true, repository: createInMemoryLongTermMemoryRepository(), emitClientEvents: false,
    embeddings: { embed: vi.fn(async ({ texts }) => ({ modelFingerprint: "initial",
      dimensions: 2, vectors: texts.map(() => [1, 0]) })) },
  });
  const prepare = vi.fn(baseMemory.learning!.prepare);
  const request = deriveTestRequestExecutionScope(f.request, { longTermMemory: {
    ...baseMemory, retrieve: f.memory.retrieve, learning: { ...baseMemory.learning!, prepare },
  } });
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async input => {
    expect(f.memory.retrieve).toHaveBeenCalledOnce();
    const gate = supervisorFormatName(input) === "supervisor_procedure_gate";
    expect(modelMessages(input).filter(message => message.content === initialMessage.content)).toEqual(gate ? [] : [initialMessage]);
    expect(JSON.stringify(input.messages)).toContain(MEMORY_RECORD.content);
    expect(modelMessages(input).filter(message => message.role === "user" && message.content === REQUEST_PROMPT)).toHaveLength(1);
    expect(recallCapsules(input)).toEqual([]);
    if (input.modelStep === "supervisor.decision") {
      expect(prepare).not.toHaveBeenCalled();
      expect(JSON.stringify(input.format)).not.toContain("recall_memory");
    } else expect(prepare).toHaveBeenCalledOnce();
    return invoke(input);
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  const inputs = f.invoke.mock.calls.map(([input]) => input);
  expect(inputs.map(input => input.modelStep)).toEqual([
    "supervisor.decision", "supervisor.response", "supervisor.response",
  ]);
  for (const input of inputs) {
    const gate = supervisorFormatName(input) === "supervisor_procedure_gate";
    expect(modelMessages(input).filter(entry => entry.content === initialMessage.content)).toEqual(gate ? [] : [initialMessage]);
    expect(JSON.stringify(input.messages)).toContain(MEMORY_RECORD.content);
    expect(modelMessages(input).filter(entry => entry.role === "user" && entry.content === REQUEST_PROMPT)).toHaveLength(1);
  }
  expect(inputs[1]!.format).toMatchObject({ name: "supervisor_memory_candidates" });
  expect(inputs[2]).not.toHaveProperty("format");
  expect(f.memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual([REQUEST_PROMPT]);
});

test("a model-selected recall replaces the initial reference for subsequent decision and RAW response", async () => {
  let decisions = 0;
  const f = createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate: () => ({ action: "invoke_role", roleId: "worker", objective: "Determine the saved preference needed for the answer." }),
    retrieve: async ({ query }) => ({ available: true,
      records: [{ ...MEMORY_RECORD, content: query === REQUEST_PROMPT ? MEMORY_RECORD.content : "Explicitly recalled preference." }],
      ...(query === REQUEST_PROMPT ? { message: initialMessage } : {}),
    }),
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
      if (input.modelStep === "worker.evidence") return workerEvidenceDecision(input, false);
      if (input.modelStep === "worker.result") return "The answer requires the user's stored formatting preference.";
      decisions += 1;
      if (decisions === 1) {
        expect(modelMessages(input)).toContainEqual(initialMessage);
        return { action: "recall_memory", query: RECALL_QUERY, acknowledgement: "Checking memory." };
      }
      const returned = modelMessages(input).find(({ content }) => content.includes('"kind":"runtime_child_result"'));
      expect(returned).toBeDefined();
      expect(JSON.parse(returned!.content)).toMatchObject({
        childCallId: "call-2", resultRef: "result-1", roleId: "worker",
        summary: "The answer requires the user's stored formatting preference.",
      });
      expect(modelMessages(input)).not.toContainEqual(initialMessage);
      expect(JSON.stringify(recallCapsules(input))).toContain("Explicitly recalled preference.");
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual([REQUEST_PROMPT, RECALL_QUERY]);
  const response = f.invoke.mock.calls.at(-1)![0];
  expect(modelMessages(response)).not.toContainEqual(initialMessage);
  expect(JSON.stringify(recallCapsules(response))).toContain("Explicitly recalled preference.");
});

test("steering retains the startup reference without an automatic refresh", async () => {
  const f = memoryHarness();
  const invoke = f.invoke.getMockImplementation()!;
  let decisions = 0;
  f.invoke.mockImplementation(async input => {
    if (supervisorFormatName(input) === "supervisor_procedure_gate") expect(modelMessages(input)).not.toContainEqual(initialMessage);
    else expect(modelMessages(input)).toContainEqual(initialMessage);
    expect(JSON.stringify(input.messages)).toContain(MEMORY_RECORD.content);
    if (input.modelStep === "supervisor.decision" && ++decisions === 1)
      f.requestSteering.append({ steerId: "change-style", text: "Make the answer even shorter." });
    return invoke(input);
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(decisions).toBe(2);
  expect(f.memory.retrieve).toHaveBeenCalledOnce();
});

test.each(["empty", "unavailable"])("%s automatic lookup stays prepared through checkpoint restore", async outcome => {
  const f = memoryHarness();
  f.memory.retrieve.mockResolvedValue({ available: outcome === "empty", records: [] });
  const initialMemory = await prepareInitialMemory(f.request);
  expect(initialMemory).toEqual({});
  const ledger = createRoleCallLedger({ requestId: f.request.requestId,
    policy: createRequestRoleCallPolicy(f.request.executionPolicy), initialMemory });
  expect((await resolveRoleCallTransactions(ledger).createRoot({ expectedHead: ledger.current() })).ok).toBe(true);
  const saved = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)));
  expect(await prepareInitialMemory(f.request, saved.state.initialMemory)).toEqual({});
  expect(f.memory.retrieve).toHaveBeenCalledOnce();
});

test("a pre-change SUPER checkpoint without initial memory uses the existing initialization fallback", async () => {
  const f = memoryHarness();
  const policy = createRequestRoleCallPolicy(f.request.executionPolicy);
  const ledger = createRoleCallLedger({ requestId: f.request.requestId, policy });
  expect((await resolveRoleCallTransactions(ledger).createRoot({ expectedHead: ledger.current() })).ok).toBe(true);
  const opened = await ledger.apply({ expectedHead: ledger.current(), command: {
    authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "worker", objective: "Perform the approved action.",
  } });
  expect(opened.ok).toBe(true);
  expect((await resolveRoleCallTransactions(ledger).beginCapabilityExecution({
    expectedHead: ledger.current(), callId: "call-2", invocationAttempt: 1,
    capabilityId: "fixture.observe", declaredEffect: "observation", intent: "Observe.",
    controlsJson: "{}", actionFingerprint: `sha256:${"a".repeat(64)}`,
  })).ok).toBe(true);
  const saved = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)));
  expect(saved.state).not.toHaveProperty("initialMemory");
  const initialMemory = await prepareInitialMemory(f.request, saved.state.initialMemory);
  const restored = createRoleCallLedger({ requestId: f.request.requestId, policy, checkpoint: saved, initialMemory });
  expect(restored.current().state.initialMemory).toEqual({ message: initialMessage });
  expect(restored.current().state.memoryRecalls).toEqual([]);
  expect(f.memory.retrieve).toHaveBeenCalledOnce();
});
