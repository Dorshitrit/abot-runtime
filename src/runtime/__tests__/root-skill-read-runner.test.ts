import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import type {
  KnowledgeSkillDocument,
  KnowledgeSkillStore,
} from "../knowledge-skills/store.js";
import {
  createMemoryRecallHarness,
  FINAL_RESPONSE,
  REQUEST_PROMPT,
  type RecallModelInput,
  jsonMessages,
  modelMessages,
} from "./support/memory-recall-runner.js";

const document: KnowledgeSkillDocument = {
  skillId: "personal-architecture",
  name: "Architecture conventions",
  description: "How to explain architecture.",
  source: "personal",
  revision: 1,
  content: "Explain one owning layer and one caller boundary.",
};
const respond = {
  action: "respond",
};
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

function attachStore(
  request: ReturnType<typeof createMemoryRecallHarness>["request"],
  store: KnowledgeSkillStore,
) {
  return createRequestExecutionScope({
    seed: request,
    executionPolicy: request.executionPolicy,
    knowledgeSkillStore: store,
    createWorkerCapabilities: () => request.workerCapabilities.provider,
  });
}

function skillActionIndexes(input: RecallModelInput): number[] {
  return modelMessages(input).flatMap((message, index) => {
    if (message.role !== "assistant") return [];
    try {
      const action = JSON.parse(message.content).decision?.action;
      return action === "list_skills" || action === "read_skills" ? [index] : [];
    } catch { return []; }
  });
}

function assertSkillContinuation(
  input: RecallModelInput,
  expected: { readId: string; action: "list_skills" | "read_skills"; skillIds?: readonly string[]; documents?: readonly string[] },
) {
  const messages = modelMessages(input);
  const prompts = messages.flatMap((message, index) =>
    message.role === "user" && message.content === REQUEST_PROMPT ? [index] : []);
  expect(prompts).toHaveLength(1);
  const actions = skillActionIndexes(input);
  expect(actions).toHaveLength(1);
  const actionIndex = actions[0]!;
  expect(actionIndex).toBeGreaterThan(prompts[0]!);
  expect(JSON.parse(messages[actionIndex]!.content)).toEqual({
    decision: { action: expected.action, ...(expected.skillIds ? { skillIds: expected.skillIds } : {}) },
  });
  const resultIndexes = messages.flatMap((message, index) => {
    try {
      const value = JSON.parse(message.content);
      return value.kind === "runtime_core_skill_read_v1" && value.read.readId === expected.readId ? [index] : [];
    } catch { return []; }
  });
  expect(resultIndexes.length).toBeGreaterThan(0);
  expect(resultIndexes).toEqual(resultIndexes.map((_, index) => actionIndex + 1 + index));
  for (const content of expected.documents ?? []) {
    expect(messages.filter((message) => message.content.includes(content))).toHaveLength(1);
  }
  expect(JSON.stringify(input.format)).not.toContain('"responseRecommendation"');
}

test("SUPER reads multiple supplied Skills directly without LIST, waking Worker or duplicating their content", async () => {
  let selections = 0;
  const secondDocument = { ...document, skillId: "second-guide", name: "Second guide",
    content: "Preserve exact interface names in the explanation." };
  const documents = [document, secondDocument];
  const store = {
    list: vi.fn(() => documents.map(({ skillId, name, description }) => ({ skillId, name, description }))),
    read: vi.fn((skillId: string) => documents.find((entry) => entry.skillId === skillId)),
  };
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    enabled: false,
    selectSkills(input) {
      selections += 1;
      expect(JSON.stringify(input.messages)).not.toContain(document.content);
      expect(JSON.stringify(input.messages)).not.toContain(secondDocument.content);
      expect(JSON.stringify(input.format)).not.toContain('"list_skills"');
      if (selections === 1) {
        for (const { name, description } of documents) {
          expect(JSON.stringify(input.messages)).toContain(name);
          expect(JSON.stringify(input.messages)).toContain(description);
        }
        return { action: "read_skills", skillIds: documents.map(({ skillId }) => skillId) };
      }
      return { action: "continue" };
    },
    decide(input) {
      assertSkillContinuation(input, {
        readId: "skill-read-1", action: "read_skills",
        skillIds: documents.map(({ skillId }) => skillId), documents: documents.map(({ content }) => content),
      });
      expect(jsonMessages(input).filter(({ kind }) => kind === "runtime_child_result")).toEqual([]);
      return respond;
    },
  });
  const request = attachStore(harness.request, store);
  await expect(runRequestRunner(request)).resolves.toMatchObject({
    output: FINAL_RESPONSE,
  });
  expect(store.read.mock.calls).toEqual(documents.map(({ skillId }) => [skillId]));
  expect(selections).toBe(2);
  expect(store.list).toHaveBeenCalledTimes(selections);
  expect(harness.getAdapters).not.toHaveBeenCalled();
  const formats = harness.gatewayInvoke.mock.calls.map(([input]) =>
    typeof input.format === "object" && input.format !== null ? input.format.name : input.modelStep);
  expect(formats.slice(0, 3)).toEqual([
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_skill_selection",
  ]);
  expect(formats.at(-2)).toBe("supervisor_decision");
  expect(formats.at(-1)).toBe("supervisor.response");
  for (const [input] of harness.gatewayInvoke.mock.calls) {
    expect(
      modelMessages(input).filter(
        ({ role, content }) =>
          role === "system" && content.includes(document.content),
      ),
    ).toEqual([]);
  }
  const response = harness.gatewayInvoke.mock.calls.at(-1)![0];
  expect(JSON.stringify(jsonMessages(response))).toContain(document.content);
  expect(jsonMessages(response).some(({ kind }) => kind === "runtime_supervisor_response_recommendation_v1")).toBe(false);
});

test("a failed core read returns an explicit failure to SUPER without claiming guidance was loaded", async () => {
  let selections = 0;
  const store = { list: () => [{ skillId: "missing", name: "Missing guide", description: "A known reference." }], read: () => undefined };
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    enabled: false,
    selectSkills() {
      selections += 1;
      return { action: "read_skills", skillIds: ["missing"] };
    },
    decide(input) {
      assertSkillContinuation(input, { readId: "skill-read-1", action: "read_skills", skillIds: ["missing"] });
      expect(jsonMessages(input).filter(({ kind }) => kind === "runtime_child_result")).toEqual([]);
      expect(JSON.stringify(jsonMessages(input))).toContain(
        "knowledge_skill_not_found",
      );
      expect(JSON.stringify(jsonMessages(input))).not.toContain(
        document.content,
      );
      return respond;
    },
  });
  await expect(
    runRequestRunner(attachStore(harness.request, store)),
  ).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(1);
});

test("hands the read snapshot to Planner and its Worker without objective copies or a repeated read", async () => {
  let supervisor = 0;
  let planner = 0;
  let selection = 0;
  const store = {
    list: () => [{ skillId: document.skillId, name: document.name, description: document.description }],
    read: vi.fn(() => document),
  };
  const objective = "Explain the architecture distinction.";
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    enabled: false,
    selectSkills(input) {
      expect(JSON.stringify(input.messages)).not.toContain(document.content);
      return ++selection === 1
        ? { action: "read_skills", skillIds: [document.skillId] }
        : { action: "continue" };
    },
    decide(input) {
      if (typeof input.format === "object" && input.format?.name === "supervisor_working_directory")
        return JSON.stringify({ workingDirectory: "." });
      expect(JSON.stringify(jsonMessages(input))).toContain(document.content);
      if (input.modelStep === "supervisor.decision") {
        if (++supervisor === 1) {
          assertSkillContinuation(input, {
            readId: "skill-read-1", action: "read_skills",
            skillIds: [document.skillId], documents: [document.content],
          });
          return { action: "invoke_role", roleId: "planner", objective };
        }
        expect(supervisor).toBe(2);
        expect(skillActionIndexes(input)).toEqual([]);
        expect(jsonMessages(input).some(({ kind }) => kind === "runtime_child_result")).toBe(true);
        return { action: "respond" };
      }
      if (input.modelStep === "planner.decision") {
        if (++planner === 1) return {
          action: "invoke_role", roleId: "worker",
          plan: { summary: objective, items: [{ title: "Explain the distinction", objective }] },
          selectedItemIndexes: [0],
        };
        return { action: "return_result", result: "The requested distinction was explained." };
      }
      if (input.modelStep === "worker.decision") return { action: "return_result" };
      expect(input.modelStep).toBe("worker.result");
      return "The owner controls state and the adapter executes effects.";
    },
  });
  await expect(runRequestRunner(attachStore(harness.request, store))).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(store.read).toHaveBeenCalledExactlyOnceWith(document.skillId);
  expect(harness.request.onAcknowledgement).toHaveBeenCalledOnce();
  expect(harness.gatewayInvoke.mock.calls.filter(([input]) => input.modelStep === "worker.decision")).toHaveLength(1);
  for (const [input] of harness.gatewayInvoke.mock.calls) {
    const assignments = jsonMessages(input).filter(({ kind }) => String(kind).includes("assignment"));
    for (const assignment of assignments) expect(assignment.objective).toBe(objective);
  }
});
