import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { SUPERVISOR_SKILL_READ_STATE_KIND } from "../steps/supervisor-decision/skill-read-state.js";
import { createMemoryRecallHarness, FINAL_RESPONSE, REQUEST_PROMPT, modelMessages, type RecallModelInput } from "./support/memory-recall-runner.js";
import { defaultSupervisorPresentation, supervisorFormatName } from "./support/supervisor-model-phases.js";

const skill = {
  skillId: "phase-guide", name: "PHASE_GUIDE_NAME", description: "PHASE_GUIDE_DESCRIPTION",
  source: "personal" as const, revision: 1, content: "PHASE_GUIDE_BODY: preserve the accepted scope.",
};
const irrelevant = { ...skill, skillId: "other-guide", name: "OTHER_GUIDE_NAME", description: "Another workflow.", content: "OTHER_GUIDE_BODY" };
const history = [{ id: "history-1", role: "user" as const, content: "OLD_HISTORY_SENTINEL", requestId: "old-request", createdAt: "2026-10-01T00:00:00.000Z" }];

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

function fixture(options: Parameters<typeof createMemoryRecallHarness>[0]) {
  const harness = createMemoryRecallHarness(options);
  const documents = [skill, irrelevant];
  const store = {
    list: vi.fn(() => documents.map(({ content: _content, ...metadata }) => metadata)),
    read: vi.fn((id: string) => documents.find(({ skillId }) => skillId === id)),
  };
  const request = createRequestExecutionScope({
    seed: { ...harness.request, historyMessages: history, shouldGenerateSessionTitle: true },
    executionPolicy: harness.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  return { ...harness, request, store };
}

function finishWorker(input: RecallModelInput) {
  if (supervisorFormatName(input) === "supervisor_working_directory")
    return JSON.stringify({ workingDirectory: "." });
  if (input.modelStep === "worker.decision") return { action: "return_result" };
  expect(input.modelStep).toBe("worker.result");
  return "The requested explanation is complete.";
}

const invokeWorker = { action: "invoke_role", roleId: "worker", objective: "Explain the requested distinction." };

test("publishes presentation once, selects from lean metadata, then classifies without Skill bodies and answers with captured guidance", async () => {
  let selections = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    present(input) {
      const text = JSON.stringify(input.messages);
      for (const value of [skill.skillId, skill.name, skill.description, skill.content]) expect(text).not.toContain(value);
      expect(input.format).toMatchObject({ name: "supervisor_presentation", schema: {
        properties: { decision: { required: ["acknowledgement", "title"], additionalProperties: false } },
      } });
      expect(JSON.stringify(input.format)).not.toContain('"action"');
      return defaultSupervisorPresentation(input);
    },
    selectSkills(input) {
      const text = JSON.stringify(input.messages);
      for (const value of [history[0]!.content, skill.content, irrelevant.content, "runtime_child_result", "runtime_core_skill_read_v1"])
        expect(text).not.toContain(value);
      expect(modelMessages(input).filter(({ role, content }) => role === "user" && content === REQUEST_PROMPT)).toHaveLength(1);
      const schema = JSON.stringify(input.format);
      for (const field of ["acknowledgement", "title", "objective", "invoke_role", "respond"]) expect(schema).not.toContain(`"${field}"`);
      expect(++selections).toBe(1);
      expect(text).toContain(skill.name);
      expect(text).toContain(skill.description);
      expect(text).not.toContain(SUPERVISOR_SKILL_READ_STATE_KIND);
      expect(text).toContain(irrelevant.name);
      return { action: "read_skills", skillIds: [skill.skillId] };
    },
    classifyProcedure(input) {
      expect(supervisorFormatName(input)).toBe("supervisor_procedure_gate");
      expect(JSON.stringify(input.messages)).not.toContain(skill.content);
      for (const action of ["list_skills", "read_skills"])
        expect(JSON.stringify(input.format)).not.toContain(`"${action}"`);
      return { requiresProcedure: false, responseRecommendation: "Answer with the accepted guidance." };
    },
    onInput(input) {
      if (input.modelStep !== "supervisor.response") return;
      expect(JSON.stringify(input.messages)).toContain(skill.content);
      expect(JSON.stringify(input.messages)).not.toContain(irrelevant.content);
    },
    decide: vi.fn(),
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate", "supervisor.response",
  ]);
  for (const [input] of f.gatewayInvoke.mock.calls) {
    if (supervisorFormatName(input) === "supervisor_skill_selection") continue;
    expect(JSON.stringify(input.messages)).not.toContain(SUPERVISOR_SKILL_READ_STATE_KIND);
  }
  expect(f.store.read.mock.calls).toEqual([[skill.skillId]]);
  expect(f.store.list).toHaveBeenCalledOnce();
  expect(f.getAdapters).not.toHaveBeenCalled();
  expect(f.request.onAcknowledgement).toHaveBeenCalledOnce();
  expect(f.request.onSessionTitle).toHaveBeenCalledExactlyOnceWith("Handle the request");
});

test("no matching Skill continues to ordinary routing without any read", async () => {
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills: () => ({ action: "continue" }),
    decide: () => ({ action: "respond", responseRecommendation: "Answer the current request." }),
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate", "supervisor.response",
  ]);
});

test("steering supersedes a selected Skill before any Store read or child dispatch", async () => {
  let selections = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills(input) {
      if (++selections === 1) {
        expect(f.requestSteering.append({ steerId: "change-before-read", text: "Only answer the current question." }).ok).toBe(true);
        return { action: "read_skills", skillIds: [skill.skillId] };
      }
      expect(JSON.stringify(input.messages)).toContain("Only answer the current question.");
      return { action: "continue" };
    },
    decide: () => ({ action: "respond", responseRecommendation: "Answer the updated request." }),
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(2);
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.getAdapters).not.toHaveBeenCalled();
  expect(f.request.onAcknowledgement).not.toHaveBeenCalled();
  expect(f.request.onSessionTitle).toHaveBeenCalledOnce();
});

test("EA keeps its existing decision path and never invokes SUPER preparation", async () => {
  const present = vi.fn();
  const selectSkills = vi.fn();
  const f = fixture({ policy: "execution-agent-v1", enabled: false, present, selectSkills, decide: () => ({
    action: "respond", acknowledgement: "I will answer the request.", title: "Handle the request",
  }) });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(present).not.toHaveBeenCalled();
  expect(selectSkills).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.gatewayInvoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["execution.decision", "execution.response"]);
});

test("steering during routing revises the route without reopening an accepted Skill selection", async () => {
  let selections = 0;
  let routes = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills() {
      expect(++selections).toBe(1);
      return { action: "continue" };
    },
    decide(input) {
      if (++routes === 1) {
        f.requestSteering.append({ steerId: "routing-change", text: "Use the phase guide for this request." });
        return { action: "invoke_role", roleId: "worker", objective: "OBSOLETE_OBJECTIVE" };
      }
      expect(JSON.stringify(input.messages)).toContain("Use the phase guide for this request.");
      expect(JSON.stringify(input.messages)).not.toContain(skill.content);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(1);
  expect(routes).toBe(2);
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.store.list).toHaveBeenCalledOnce();
  expect(f.gatewayInvoke.mock.calls.some(([input]) => input.modelStep === "worker.decision")).toBe(false);
});

test.each([true, false])("complete supplied metadata offers every candidate without a LIST action (read: %s)", async (read) => {
  const documents = Array.from({ length: 24 }, (_, index) => ({
    ...skill, skillId: `catalog-guide-${index}`, name: `Catalog guide ${index}`,
    description: "Guidance for a distinct technical workflow with specific verification conventions.",
    content: `CATALOG_BODY_${index}: follow the accepted scope.`,
  }));
  const target = documents.at(-1)!;
  const store = {
    list: vi.fn(() => documents.map(({ skillId, name, description }) => ({ skillId, name, description }))),
    read: vi.fn((id: string) => documents.find(({ skillId }) => skillId === id)),
  };
  let selections = 0;
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills(input) {
      const text = JSON.stringify(input.messages);
      expect(text).not.toContain("CATALOG_BODY_");
      expect(text).not.toContain("Partial catalog");
      expect(text).not.toContain("list_skills");
      const schema = JSON.stringify(input.format);
      expect(schema).not.toContain('"list_skills"');
      expect(schema).toContain('"read_skills"');
      expect(schema).toContain('"continue"');
      expect(++selections).toBe(1);
      for (const document of documents) expect(text).toContain(document.description);
      expect(schema).toContain(`"${target.skillId}"`);
      return read ? { action: "read_skills", skillIds: [target.skillId] } : { action: "continue" };
    },
    classifyProcedure(input) {
      expect(JSON.stringify(input.messages)).not.toContain(target.content);
      return { requiresProcedure: false, responseRecommendation: "Answer the current request." };
    },
    onInput(input) {
      if (input.modelStep !== "supervisor.response") return;
      const text = JSON.stringify(input.messages);
      if (read) expect(text).toContain(target.content);
      else expect(text).not.toContain(target.content);
    },
    decide: vi.fn(),
  });
  const request = createRequestExecutionScope({
    seed: harness.request, executionPolicy: harness.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(1);
  expect(store.list).toHaveBeenCalledOnce();
  expect(store.read.mock.calls).toEqual(read ? [[target.skillId]] : []);
});


test("after a role return a repeated successful ID is repaired without a second Store read", async () => {
  let selections = 0;
  let routes = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills(input) {
      selections++;
      if (selections === 1) return { action: "read_skills", skillIds: [skill.skillId] };
      const messages = modelMessages(input);
      const state = JSON.parse(messages[1]!.content as string);
      expect(state.skills).toEqual([{ skillId: skill.skillId, name: skill.name, nameTruncated: false }]);
      if (selections === 2) return { action: "read_skills", skillIds: [skill.skillId] };
      return { action: "continue" };
    },
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate() { routes++; return invokeWorker; },
    decide(input) {
      if (supervisorFormatName(input) !== "supervisor_decision") return finishWorker(input);
      expect(++routes).toBe(2);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.store.read.mock.calls).toEqual([[skill.skillId]]);
  expect(f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate", "supervisor_delegation", "supervisor_working_directory",
    "worker.decision", "worker.result", "supervisor_skill_selection",
    "supervisor_skill_selection", "supervisor_decision", "supervisor.response",
  ]);
});

test("an empty catalog bypasses selection and routes without a Store read", async () => {
  const selectSkills = vi.fn(() => ({ action: "continue" }));
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false, selectSkills,
    decide: () => ({ action: "respond" }),
  });
  f.store.list.mockReturnValue([]);
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selectSkills).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_presentation", "supervisor_procedure_gate", "supervisor.response",
  ]);
});

test("reading every remaining candidate bypasses the next selection and retains both response bodies", async () => {
  const selectSkills = vi.fn(() => ({ action: "read_skills", skillIds: [skill.skillId, irrelevant.skillId] }));
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false, selectSkills,
    classifyProcedure: () => ({ requiresProcedure: false, responseRecommendation: "Answer using the guides." }),
    onInput(input) {
      if (input.modelStep !== "supervisor.response") return;
      expect(JSON.stringify(input.messages)).toContain(skill.content);
      expect(JSON.stringify(input.messages)).toContain(irrelevant.content);
    },
    decide: vi.fn(),
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selectSkills).toHaveBeenCalledOnce();
  expect(f.store.read.mock.calls).toEqual([[skill.skillId], [irrelevant.skillId]]);
});

test.each(["name", "unknown", "duplicate", "mixed"])("repairs an invalid %s batch atomically", async (kind) => {
  let selections = 0;
  let routes = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills() {
      selections++;
      if (selections === 1) return { action: "read_skills", skillIds: [skill.skillId] };
      if (selections === 2) {
        const ids = {
          name: [irrelevant.name], unknown: [irrelevant.skillId, "unknown-id"],
          duplicate: [irrelevant.skillId, irrelevant.skillId], mixed: [irrelevant.skillId, skill.skillId],
        };
        return { action: "read_skills", skillIds: ids[kind as keyof typeof ids] };
      }
      expect(f.store.read.mock.calls).toEqual([[skill.skillId]]);
      return { action: "read_skills", skillIds: [irrelevant.skillId] };
    },
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate() { routes++; return invokeWorker; },
    decide(input) {
      if (supervisorFormatName(input) !== "supervisor_decision") return finishWorker(input);
      expect(++routes).toBe(2);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(3);
  expect(f.store.read.mock.calls).toEqual([[skill.skillId], [irrelevant.skillId]]);
  expect(f.store.list).toHaveBeenCalledTimes(2); // One snapshot per SUPER entry; repair reuses its snapshot.
});

test("persistent repeated IDs exhaust exactly two repairs and use existing failure finalization", async () => {
  let selections = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills() {
      selections++;
      return { action: "read_skills", skillIds: [skill.skillId] };
    },
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate: () => invokeWorker,
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_decision") return invokeWorker;
      if (input.modelStep !== "degraded.finalization") return finishWorker(input);
      expect(input.modelStep).toBe("degraded.finalization");
      return JSON.stringify({ failureNotice: "The request could not be completed.", nextStep: "Please try again." });
    },
  });
  const request = createRequestExecutionScope({
    seed: { ...f.request, runnerConfig: {
      ...f.request.runnerConfig,
      steps: { ...f.request.runnerConfig.steps, "degraded.finalization": { timeoutMs: 20_000 } },
    } },
    executionPolicy: f.request.executionPolicy, knowledgeSkillStore: f.store,
    createWorkerCapabilities: () => f.request.workerCapabilities.provider,
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({
    disposition: "blocked",
    output: expect.stringContaining("The request could not be completed."),
  });
  expect(selections).toBe(4); // First successful selection, then initial rejection and two repairs.
  expect(f.store.read.mock.calls).toEqual([[skill.skillId]]);
  expect(f.store.list).toHaveBeenCalledTimes(2);
  expect(f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate", "supervisor_delegation", "supervisor_working_directory",
    "worker.decision", "worker.result", "supervisor_skill_selection",
    "supervisor_skill_selection", "supervisor_skill_selection", "degraded.finalization",
  ]);
});
