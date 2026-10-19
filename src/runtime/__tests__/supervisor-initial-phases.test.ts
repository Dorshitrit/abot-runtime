import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { createMemoryRecallHarness, FINAL_RESPONSE, REQUEST_PROMPT, modelMessages } from "./support/memory-recall-runner.js";
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

test("publishes presentation once, selects from lean metadata, then routes with the captured Skill", async () => {
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
      if (++selections === 1) {
        expect(text).toContain(skill.name);
        expect(text).toContain(skill.description);
        return { action: "read_skills", skillIds: [skill.skillId] };
      }
      expect(text).not.toContain(skill.name);
      expect(text).toContain(irrelevant.name);
      return { action: "continue" };
    },
    decide(input) {
      expect(supervisorFormatName(input)).toBe("supervisor_decision");
      expect(JSON.stringify(input.messages)).toContain(skill.content);
      expect(JSON.stringify(input.messages)).not.toContain(irrelevant.content);
      for (const action of ["list_skills", "read_skills"])
        expect(JSON.stringify(input.format)).not.toContain(`"${action}"`);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(f.gatewayInvoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_skill_selection",
    "supervisor_decision", "supervisor.response",
  ]);
  expect(f.store.read).toHaveBeenCalledExactlyOnceWith(skill.skillId);
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
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_decision", "supervisor.response",
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

test("steering during routing restarts Skill selection before accepting a new route", async () => {
  let selections = 0;
  let routes = 0;
  const f = fixture({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills(input) {
      if (++selections === 1) return { action: "continue" };
      expect(JSON.stringify(input.messages)).toContain("Use the phase guide for this request.");
      return selections === 2 ? { action: "read_skills", skillIds: [skill.skillId] } : { action: "continue" };
    },
    decide(input) {
      if (++routes === 1) {
        f.requestSteering.append({ steerId: "routing-change", text: "Use the phase guide for this request." });
        return { action: "invoke_role", roleId: "worker", objective: "OBSOLETE_OBJECTIVE" };
      }
      expect(JSON.stringify(input.messages)).toContain(skill.content);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(f.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(3);
  expect(routes).toBe(2);
  expect(f.store.read).toHaveBeenCalledExactlyOnceWith(skill.skillId);
  expect(f.gatewayInvoke.mock.calls.some(([input]) => input.modelStep === "worker.decision")).toBe(false);
});

test.each([true, false])("partial supplied metadata offers READ or continue without a LIST call (read: %s)", async (read) => {
  const documents = Array.from({ length: 24 }, (_, index) => ({
    ...skill, skillId: `catalog-guide-${index}`, name: `Catalog guide ${index}`,
    description: "Guidance for a distinct technical workflow with specific verification conventions.",
    content: `CATALOG_BODY_${index}: follow the accepted scope.`,
  }));
  const target = documents[0]!;
  const omitted = documents.at(-1)!;
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
      expect(text).toContain("Partial catalog");
      expect(text).not.toContain("list_skills");
      expect(text).not.toContain(`[${omitted.skillId}]:`);
      const schema = JSON.stringify(input.format);
      expect(schema).not.toContain('"list_skills"');
      expect(schema).toContain('"read_skills"');
      expect(schema).toContain('"continue"');
      if (++selections === 1) {
        expect(text).toContain(`[${target.skillId}]:`);
        return read ? { action: "read_skills", skillIds: [target.skillId] } : { action: "continue" };
      }
      expect(text).not.toContain(`[${target.skillId}]:`);
      return { action: "continue" };
    },
    decide(input) {
      const text = JSON.stringify(input.messages);
      if (read) expect(text).toContain(target.content);
      else expect(text).not.toContain(target.content);
      return { action: "respond" };
    },
  });
  const request = createRequestExecutionScope({
    seed: harness.request, executionPolicy: harness.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
  await expect(runRequestRunner(request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(read ? 2 : 1);
  expect(store.list).toHaveBeenCalledTimes(selections); // Only metadata projection for each selection.
  expect(store.read.mock.calls).toEqual(read ? [[target.skillId]] : []);
});
