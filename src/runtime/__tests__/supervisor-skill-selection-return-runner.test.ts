import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { SUPERVISOR_SKILL_SELECTION_RETURN_CONTEXT_KIND } from "../steps/supervisor-decision/skill-selection-continuation.js";
import {
  createMemoryRecallHarness, FINAL_RESPONSE, jsonMessages, modelMessages, REQUEST_PROMPT,
  type RecallModelInput,
} from "./support/memory-recall-runner.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const documents = Array.from({ length: 2 }, (_, index) => ({
  skillId: `return-guide-${index}`, name: `Return guide ${index}`, description: `Guidance for requirement ${index}.`,
  content: `RETURN_GUIDANCE_BODY_${index}: preserve the requested verification.`,
}));
const objective = "Verify the target and report whether the result was saved.";
const summary = "The target was checked and the result was saved at /workspace/result.txt.";

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

function returnCapsules(input: RecallModelInput) {
  return jsonMessages(input).filter(({ kind }) => kind === SUPERVISOR_SKILL_SELECTION_RETURN_CONTEXT_KIND);
}

test.each(["completed", "failed"] as const)(
  "a %s Worker return reaches only the reopened Skill selection with the canonical result",
  async (outcome) => {
    let selections = 0;
    let routes = 0;
    let returnedContext: Record<string, unknown> | undefined;
    const f = fixture({
      policy: "supervisor-worker-v1", enabled: false,
      selectSkills(input) {
        const capsules = returnCapsules(input);
        expect(modelMessages(input).filter(({ role }) => role === "user"))
          .toEqual([{ role: "user", content: REQUEST_PROMPT }]);
        expect(modelMessages(input).some(({ role }) => role === "assistant")).toBe(false);
        for (const document of documents) expect(JSON.stringify(input.messages)).not.toContain(document.content);
        if (++selections === 1) {
          expect(capsules).toEqual([]);
          return { action: "read_skills", skillIds: [documents[0]!.skillId] };
        }
        expect(selections).toBe(2);
        expect(capsules).toHaveLength(1);
        returnedContext = capsules[0]!;
        expect(returnedContext).toMatchObject({
          requestId: f.request.requestId, roleId: "worker", objective, outcome,
          objectiveTruncated: false, summaryTruncated: false,
        });
        expect(returnedContext.summary).toEqual(expect.any(String));
        expect(String(returnedContext.summary).length).toBeGreaterThan(0);
        if (outcome === "completed") expect(returnedContext.summary).toBe(summary);
        return { action: "continue" };
      },
      classifyProcedure: () => ({ requiresProcedure: true }),
      delegate(input) {
        expect(JSON.stringify(input.messages)).not.toContain(documents[0]!.content);
        routes++;
        return { action: "invoke_role", roleId: "worker", objective };
      },
      decide(input) {
        const phase = supervisorFormatName(input);
        if (phase === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
        if (phase === "supervisor_decision") {
          expect(JSON.stringify(input.messages)).toContain(documents[0]!.content);
          expect(++routes).toBe(2);
          expect(returnedContext).toBeDefined();
          const child = jsonMessages(input).find(({ kind }) => kind === "runtime_child_result")!;
          expect(child).toBeDefined();
          for (const key of ["callerCallId", "childCallId", "resultRef", "roleId", "outcome", "summary"])
            expect(returnedContext![key]).toEqual(child[key]);
          return { action: "respond" };
        }
        if (input.modelStep === "worker.decision")
          return { action: outcome === "completed" ? "return_result" : "invalid_worker_action" };
        expect(input.modelStep).toBe("worker.result");
        return summary;
      },
    });
    await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
    expect(selections).toBe(2);
    expect(routes).toBe(2);
    expect(f.store.read.mock.calls).toEqual([[documents[0]!.skillId]]);
    const inputs = f.gatewayInvoke.mock.calls.map(([input]) => input);
    for (const input of inputs) {
      if (supervisorFormatName(input) !== "supervisor_skill_selection") expect(returnCapsules(input)).toEqual([]);
    }
    expect(inputs.some(({ modelStep }) => modelStep === "degraded.finalization")).toBe(false);
    expect(inputs.filter(({ modelStep }) => modelStep === "worker.decision"))
      .toHaveLength(outcome === "completed" ? 1 : 3);
  },
);

test("EA does not invoke SUPER Skill selection or receive its returned-role capsule", async () => {
  const selectSkills = vi.fn(() => ({ action: "continue" }));
  const f = fixture({
    policy: "execution-agent-v1", enabled: false, selectSkills,
    decide(input) {
      expect(input.modelStep).toBe("execution.decision");
      return { action: "respond", acknowledgement: "I will answer the request." };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selectSkills).not.toHaveBeenCalled();
  for (const [input] of f.gatewayInvoke.mock.calls) expect(returnCapsules(input)).toEqual([]);
});
