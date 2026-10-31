import { workerEvidenceDecision } from "./support/worker-evidence-script.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { REVIEWER_AUDIT_CONTEXT_KIND } from "../steps/reviewer-decision/model-context.js";
import {
  createMemoryRecallHarness, FINAL_RESPONSE, jsonMessages, modelMessages, recallCapsules, RECALL_QUERY,
  type RecallModelInput,
} from "./support/memory-recall-runner.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const documents = Array.from({ length: 5 }, (_, index) => ({
  skillId: `entry-guide-${index}`, name: `Entry guide ${index}`, description: `Conventions for task ${index}.`,
  content: `CAPTURED_ENTRY_GUIDANCE_${index}: preserve the requested verification.`,
}));

function fixture(options: Parameters<typeof createMemoryRecallHarness>[0]) {
  const harness = createMemoryRecallHarness(options);
  const store = {
    list: vi.fn(() => documents.map(({ content: _content, ...metadata }) => metadata)),
    read: vi.fn((id: string) => documents.find(({ skillId }) => skillId === id)),
  };
  const request = createRequestExecutionScope({
    seed: harness.request, executionPolicy: harness.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  return { ...harness, request, store };
}

function finishWorker(input: RecallModelInput) {
  if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
  if (input.modelStep === "worker.evidence") return workerEvidenceDecision(input, false);
  expect(input.modelStep).toBe("worker.result");
  return "The initial check is complete.";
}

test.each([false, true])("the returned-entry selection stays closed through recall (read=%s)", async (read) => {
  const selected = documents.slice(0, 2);
  let selections = 0;
  const selectSkills = vi.fn(() => ++selections === 1 || !read
    ? { action: "continue" }
    : { action: "read_skills", skillIds: selected.map(({ skillId }) => skillId) });
  let routes = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", selectSkills,
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate: () => ({ action: "invoke_role", roleId: "worker", objective: "Check the current request." }),
    decide(input) {
      if (supervisorFormatName(input) !== "supervisor_decision") return finishWorker(input);
      for (const { content } of selected) {
        if (read) expect(JSON.stringify(input.messages)).toContain(content);
        else expect(JSON.stringify(input.messages)).not.toContain(content);
      }
      if (++routes === 1) return { action: "recall_memory", query: RECALL_QUERY };
      expect(recallCapsules(input)).toHaveLength(1);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(routes).toBe(2);
  expect(selectSkills).toHaveBeenCalledTimes(2);
  expect(f.store.list).toHaveBeenCalledTimes(2);
  expect(f.store.read.mock.calls).toEqual(read ? selected.map(({ skillId }) => [skillId]) : []);
  expect(f.memory.retrieve.mock.calls.filter(([input]) => input.query === RECALL_QUERY)).toHaveLength(1);
  expect(f.gatewayInvoke.mock.calls.filter(([input]) => input.modelStep === "worker.evidence")).toHaveLength(1);
});

test("each direct Worker, Planner and Reviewer return opens one selection, while a nested Worker return does not", async () => {
  let selections = 0;
  let routes = 0;
  let plannerCalls = 0;
  let workerReturns = 0;
  const objective = "Explain the requested verification.";
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills(input) {
      if (selections === 2) expect(workerReturns).toBe(2);
      const selected = documents[selections++]!;
      const catalog = modelMessages(input)[0]!.content;
      for (const loaded of documents.slice(0, selections - 1)) expect(catalog).not.toContain(`"${loaded.skillId}"`);
      expect(catalog).toContain(`"${selected.skillId}"`);
      return { action: "read_skills", skillIds: [selected.skillId] };
    },
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate(input) {
      expect(selections).toBe(++routes);
      expect(jsonMessages(input).filter(({ kind }) => kind === "runtime_core_skill_read_v1"))
        .toEqual([expect.objectContaining({
          authority: "passive_reference", purpose: "skill_guidance", document: documents[0],
        })]);
      return { action: "invoke_role", roleId: "worker", objective };
    },
    decide(input) {
      const phase = supervisorFormatName(input);
      if (phase === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
      if (phase === "supervisor_decision") {
        routes++;
        expect(selections).toBe(routes);
        for (const { content } of documents.slice(0, selections))
          expect(JSON.stringify(input.messages)).toContain(content);
        const returned = jsonMessages(input).filter(({ kind }) => kind === "runtime_child_result");
        expect(returned.at(-1)).toMatchObject({ roleId: ["worker", "planner", "reviewer"][routes - 2] });
        if (routes === 2) return { action: "invoke_role", roleId: "planner", objective };
        if (routes === 3) return { action: "invoke_role", roleId: "reviewer" };
        expect(routes).toBe(4);
        return { action: "respond" };
      }
      if (input.modelStep === "planner.decision") {
        if (++plannerCalls === 1) return {
          action: "invoke_role", roleId: "worker",
          plan: { summary: objective, items: [{ title: "Explain verification", objective }] },
          selectedItemIndexes: [0],
        };
        expect(selections).toBe(2);
        return { action: "return_result", result: "The requested verification was explained." };
      }
      if (input.modelStep === "worker.evidence") return workerEvidenceDecision(input, false);
      if (input.modelStep === "worker.result") {
        workerReturns++;
        return "The requested verification is complete.";
      }
      expect(input.modelStep).toBe("reviewer.decision");
      const assignment = jsonMessages(input).find(({ kind }) => kind === REVIEWER_AUDIT_CONTEXT_KIND) as {
        auditScope: { reviewScopeId: string }; effects: readonly { evidenceRef: string }[];
      };
      const evidenceRefs = assignment.effects.map(({ evidenceRef }) => evidenceRef);
      return {
        action: "pass", reviewScopeId: assignment.auditScope.reviewScopeId,
        audit: {
          evidenceAssessments: evidenceRefs.map((evidenceRef) => ({
            evidenceRef, status: "supports", finding: "The result establishes the requested explanation.",
          })),
          completionAssessment: { status: "satisfied", evidenceRefs, finding: "The requested explanation is complete." },
        },
        summary: "The verification explanation is complete.", gaps: [],
      };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(4);
  expect(routes).toBe(4);
  expect(plannerCalls).toBe(2);
  expect(f.store.list).toHaveBeenCalledTimes(4);
  expect(f.store.read.mock.calls).toEqual(documents.slice(0, 4).map(({ skillId }) => [skillId]));
  // Each read re-enters SUPER with the same returned result; it must route without opening another selection.
  const phases = f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep);
  const selectionIndexes = phases.flatMap((phase, index) => phase === "supervisor_skill_selection" ? [index] : []);
  for (const [entry, index] of selectionIndexes.entries())
    expect(phases[index + 1]).toBe(entry === 0 ? "supervisor_procedure_gate" : "supervisor_decision");
});

test("repairing a rejected delegation cannot reopen selection before the child returns", async () => {
  let delegations = 0;
  const selectSkills = vi.fn(() => ({ action: "continue" }));
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false, selectSkills,
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate(input) {
      expect(supervisorFormatName(input)).toBe("supervisor_delegation");
      expect(selectSkills).toHaveBeenCalledOnce();
      return { action: "invoke_role", roleId: ++delegations === 1 ? "unknown-role" : "worker", objective: "Check the request." };
    },
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_decision") return { action: "respond" };
      return finishWorker(input);
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(delegations).toBe(2);
  expect(selectSkills).toHaveBeenCalledTimes(2);
  expect(f.store.list).toHaveBeenCalledTimes(2);
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.gatewayInvoke.mock.calls.filter(([input]) => input.modelStep === "worker.evidence")).toHaveLength(1);
});

test("steering during working-directory selection reroutes without opening another Skill selection", async () => {
  let routes = 0;
  let directories = 0;
  const update = "Answer the updated question without delegating.";
  const selectSkills = vi.fn(() => ({ action: "continue" }));
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false, selectSkills,
    classifyProcedure(input) {
      if (++routes === 1) return { requiresProcedure: true };
      expect(JSON.stringify(input.messages)).toContain(update);
      return { requiresProcedure: false, responseRecommendation: "Answer the updated question." };
    },
    delegate: () => ({ action: "invoke_role", roleId: "worker", objective: "The obsolete delegated request." }),
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory") {
        expect(++directories).toBe(1);
        expect(f.requestSteering.append({ steerId: "directory-update", text: update }).ok).toBe(true);
        return JSON.stringify({ workingDirectory: "." });
      }
      throw new Error(`unexpected model phase: ${input.modelStep}`);
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(routes).toBe(2);
  expect(selectSkills).toHaveBeenCalledOnce();
  expect(f.store.list).toHaveBeenCalledOnce();
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.gatewayInvoke.mock.calls.some(([input]) => input.modelStep === "worker.evidence")).toBe(false);
});

test("an empty returned-entry catalog stays closed even when metadata becomes available during recall", async () => {
  let routes = 0;
  const selectSkills = vi.fn(() => ({ action: "continue" }));
  const f = fixture({
    policy: "supervisor-worker-v1", selectSkills,
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate: () => ({ action: "invoke_role", roleId: "worker", objective: "Check the current request." }),
    decide(input) {
      if (supervisorFormatName(input) !== "supervisor_decision") return finishWorker(input);
      if (++routes === 1) {
        f.store.list.mockReturnValue(documents);
        return { action: "recall_memory", query: RECALL_QUERY };
      }
      expect(recallCapsules(input)).toHaveLength(1);
      return { action: "respond" };
    },
  });
  f.store.list.mockReturnValue([]);
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(routes).toBe(2);
  expect(selectSkills).not.toHaveBeenCalled();
  expect(f.store.list).toHaveBeenCalledTimes(2);
  expect(f.store.read).not.toHaveBeenCalled();
});
