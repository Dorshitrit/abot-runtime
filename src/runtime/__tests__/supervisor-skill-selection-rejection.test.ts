import { workerEvidenceDecision } from "./support/worker-evidence-script.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createMemoryRecallHarness, FINAL_RESPONSE, jsonMessages, recallCapsules, RECALL_QUERY, type RecallModelInput,
} from "./support/memory-recall-runner.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const documents = Array.from({ length: 3 }, (_, index) => ({
  skillId: `rejection-guide-${index}`, name: `Rejection guide ${index}`, description: `Guidance for requirement ${index}.`,
  content: `GUIDANCE_BODY_${index}: preserve the requested verification.`,
}));
const first = documents[0]!;
const second = documents[1]!;
const duplicate = (skillId: string) => ({ action: "read_skills", skillIds: [skillId, skillId] });
const read = (skillId: string) => ({ action: "read_skills", skillIds: [skillId] });

function fixture(options: Parameters<typeof createMemoryRecallHarness>[0]) {
  const harness = createMemoryRecallHarness(options);
  const store = {
    list: vi.fn(() => documents.map(({ content: _content, ...metadata }) => metadata)),
    read: vi.fn((id: string) => documents.find(({ skillId }) => skillId === id)),
  };
  const request = createRequestExecutionScope({
    seed: {
      ...harness.request,
      runnerConfig: { ...harness.request.runnerConfig, steps: {
        ...harness.request.runnerConfig.steps, "degraded.finalization": { timeoutMs: 20_000 },
      } },
    },
    executionPolicy: harness.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  return { ...harness, request, store };
}

function finishWorker(input: RecallModelInput) {
  if (supervisorFormatName(input) === "supervisor_working_directory")
    return JSON.stringify({ workingDirectory: "." });
  if (input.modelStep === "worker.evidence") return workerEvidenceDecision(input, false);
  expect(input.modelStep).toBe("worker.result");
  return "The requested verification is complete.";
}

function expectNoDegradedFinalization(f: ReturnType<typeof fixture>) {
  expect(f.gatewayInvoke.mock.calls.some(([input]) => input.modelStep === "degraded.finalization")).toBe(false);
}

test("three eligible duplicate outputs decline the fresh batch, route normally and stay closed through recall", async () => {
  let selections = 0;
  const selectSkills = vi.fn(() => ++selections <= 3 ? duplicate(first.skillId) : { action: "continue" });
  let routes = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", selectSkills,
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate: () => ({ action: "invoke_role", roleId: "worker", objective: "Check the requested verification." }),
    decide(input) {
      if (supervisorFormatName(input) !== "supervisor_decision") return finishWorker(input);
      expect(jsonMessages(input).some(({ kind }) => kind === "runtime_core_skill_read_v1")).toBe(false);
      expect(JSON.stringify(input.messages)).not.toContain(first.content);
      if (++routes === 1) return { action: "recall_memory", query: RECALL_QUERY };
      expect(recallCapsules(input)).toHaveLength(1);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selectSkills).toHaveBeenCalledTimes(4);
  expect(routes).toBe(2);
  expect(f.store.list).toHaveBeenCalledTimes(2);
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.request.supervisorSkillSelectionWindows.bind({ rootCallId: "call-1" }).isOpen()).toBe(false);
  expectNoDegradedFinalization(f);
});

test.each([2, 3])("a valid correction on attempt %s still reads the requested batch instead of refusing early", async (validAttempt) => {
  let selections = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills: () => ++selections === validAttempt ? read(first.skillId) : duplicate(first.skillId),
    classifyProcedure(input) {
      expect(JSON.stringify(input.messages)).not.toContain(first.content);
      return { requiresProcedure: false, responseRecommendation: "Answer with the accepted guidance." };
    },
    onInput(input) {
      if (input.modelStep === "supervisor.response") expect(JSON.stringify(input.messages)).toContain(first.content);
    },
    decide: vi.fn(),
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(validAttempt);
  expect(f.store.read.mock.calls).toEqual([[first.skillId]]);
  expectNoDegradedFinalization(f);
});

test("a refused batch after child return keeps prior guidance and a later child return can select again", async () => {
  let selections = 0;
  let routes = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills() {
      selections++;
      if (selections === 1) return read(first.skillId);
      if (selections <= 4) return duplicate(second.skillId);
      expect(selections).toBe(5);
      return read(second.skillId);
    },
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate(input) {
      expect(JSON.stringify(input.messages)).not.toContain(first.content);
      return { action: "invoke_role", roleId: "worker", objective: `Complete verification ${++routes}.` };
    },
    decide(input) {
      if (supervisorFormatName(input) !== "supervisor_decision") return finishWorker(input);
      expect(JSON.stringify(input.messages)).toContain(first.content);
      routes++;
      if (routes < 3) {
        expect(JSON.stringify(input.messages)).not.toContain(second.content);
        return { action: "invoke_role", roleId: "worker", objective: `Complete verification ${routes}.` };
      }
      expect(JSON.stringify(input.messages)).toContain(second.content);
      expect(jsonMessages(input).some(({ kind }) => kind === "runtime_child_result")).toBe(true);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(5);
  expect(routes).toBe(3);
  expect(f.store.list).toHaveBeenCalledTimes(3);
  expect(f.store.read.mock.calls).toEqual([[first.skillId], [second.skillId]]);
  // A failed-read ledger marker would suppress this later selection and lose the second body.
  expectNoDegradedFinalization(f);
});

test.each([
  { label: "unknown ID", output: { action: "read_skills", skillIds: ["unknown-guide"] } },
  { label: "unknown plus duplicate", output: { action: "read_skills", skillIds: [first.skillId, first.skillId, "unknown-guide"] } },
  { label: "invalid JSON", output: "INVALID_SELECTION_JSON" },
  { label: "empty batch", output: { action: "read_skills", skillIds: [] } },
  { label: "additional fields", output: { ...duplicate(first.skillId), objective: "Extra work." } },
])("$label remains a fatal selection rejection after the existing repairs", async ({ output }) => {
  const selectSkills = vi.fn(() => output);
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false, selectSkills,
    decide(input) {
      expect(input.modelStep).toBe("degraded.finalization");
      return JSON.stringify({ failureNotice: "The request could not be completed.", nextStep: "Please try again." });
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({
    disposition: "blocked", output: expect.stringContaining("The request could not be completed."),
  });
  expect(selectSkills).toHaveBeenCalledTimes(3);
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.gatewayInvoke.mock.calls.some(([input]) => supervisorFormatName(input) === "supervisor_decision")).toBe(false);
  expect(f.gatewayInvoke.mock.calls.filter(([input]) => input.modelStep === "degraded.finalization")).toHaveLength(1);
});

test.each(["provider", "cancellation"] as const)("%s on the final duplicate repair propagates without routing or closing the window", async (kind) => {
  const failure = new Error(kind === "provider" ? "invalid_supervisor_decision" : "user_cancelled_selection");
  let selections = 0;
  const decide = vi.fn(() => ({ action: "respond" }));
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false, decide,
    selectSkills() {
      if (++selections === 3) {
        if (kind === "provider") throw failure;
        f.abortController.abort(failure);
      }
      return duplicate(first.skillId);
    },
  });
  await expect(runRequestRunner(f.request)).rejects.toBe(failure);
  expect(selections).toBe(3);
  expect(decide).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.request.supervisorSkillSelectionWindows.bind({ rootCallId: "call-1" }).isOpen()).toBe(true);
  expectNoDegradedFinalization(f);
});

test("steering during the final rejection leaves the stale window open for a fresh selection", async () => {
  let selections = 0;
  const update = "Use the guide for the updated verification.";
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills(input) {
      selections++;
      if (selections === 3) expect(f.requestSteering.append({ steerId: "fresh-selection", text: update }).ok).toBe(true);
      if (selections <= 3) return duplicate(first.skillId);
      expect(JSON.stringify(input.messages)).toContain(update);
      return read(first.skillId);
    },
    classifyProcedure(input) {
      expect(JSON.stringify(input.messages)).toContain(update);
      expect(JSON.stringify(input.messages)).not.toContain(first.content);
      return { requiresProcedure: false, responseRecommendation: "Answer the updated request." };
    },
    onInput(input) {
      if (input.modelStep !== "supervisor.response") return;
      expect(JSON.stringify(input.messages)).toContain(update);
      expect(JSON.stringify(input.messages)).toContain(first.content);
    },
    decide: vi.fn(),
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(4);
  expect(f.store.read.mock.calls).toEqual([[first.skillId]]);
  expectNoDegradedFinalization(f);
});
