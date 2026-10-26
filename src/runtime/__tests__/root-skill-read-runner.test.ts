import { workerEvidenceDecision } from "./support/worker-evidence-script.js";
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
const responseRecommendation = "Explain the supplied guidance and state any failed reads.";
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

function assertSkillSnapshot(
  input: RecallModelInput,
  expected: { readId: string; skillIds: readonly string[]; documents?: readonly string[] },
) {
  const messages = modelMessages(input);
  expect(messages.filter(({ role, content }) => role === "user" && content === REQUEST_PROMPT)).toHaveLength(1);
  const references = jsonMessages(input).filter(({ kind }) => kind === "runtime_core_skill_read_v1");
  expect(references).toHaveLength(expected.documents?.length ?? 1);
  for (const reference of references) {
    expect(reference).toMatchObject({
      authority: "passive_reference", source: "core_skills_store",
      read: { readId: expected.readId, operation: "read_skills", selectors: expected.skillIds },
    });
  }
  for (const content of expected.documents ?? []) {
    expect(messages.filter((message) => message.content.includes(content))).toHaveLength(1);
  }
}

function assertNoSkillGuidance(input: RecallModelInput, documents: readonly KnowledgeSkillDocument[]) {
  expect(jsonMessages(input).filter(({ kind }) => kind === "runtime_core_skill_read_v1")).toEqual([]);
  expect(skillActionIndexes(input)).toEqual([]);
  for (const { content } of documents) expect(JSON.stringify(input.messages)).not.toContain(content);
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
      for (const { name, description } of documents) {
        expect(JSON.stringify(input.messages)).toContain(name);
        expect(JSON.stringify(input.messages)).toContain(description);
      }
      return { action: "read_skills", skillIds: documents.map(({ skillId }) => skillId) };
    },
    classifyProcedure(input) {
      assertNoSkillGuidance(input, documents);
      return { requiresProcedure: false, responseRecommendation };
    },
    onInput(input) {
      expect(input.modelStep).toBe("supervisor.response");
      assertSkillSnapshot(input, {
        readId: "skill-read-1",
        skillIds: documents.map(({ skillId }) => skillId), documents: documents.map(({ content }) => content),
      });
      expect(jsonMessages(input).filter(({ kind }) => kind === "runtime_child_result")).toEqual([]);
    },
    decide() { throw new Error("unexpected_routing_after_direct_procedure_gate"); },
  });
  const request = attachStore(harness.request, store);
  await expect(runRequestRunner(request)).resolves.toMatchObject({
    output: FINAL_RESPONSE,
  });
  expect(store.read.mock.calls).toEqual(documents.map(({ skillId }) => [skillId]));
  expect(selections).toBe(1);
  expect(store.list).toHaveBeenCalledOnce();
  expect(harness.getAdapters).not.toHaveBeenCalled();
  const formats = harness.gatewayInvoke.mock.calls.map(([input]) =>
    typeof input.format === "object" && input.format !== null ? input.format.name : input.modelStep);
  expect(formats).toEqual([
    "supervisor_presentation", "supervisor_skill_selection", "supervisor_procedure_gate", "supervisor.response",
  ]);
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
  expect(jsonMessages(response)).toContainEqual(expect.objectContaining({
    kind: "runtime_supervisor_response_recommendation_v1", responseRecommendation,
  }));
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
    classifyProcedure(input) {
      assertNoSkillGuidance(input, [document]);
      return { requiresProcedure: false, responseRecommendation };
    },
    onInput(input) {
      expect(input.modelStep).toBe("supervisor.response");
      assertSkillSnapshot(input, { readId: "skill-read-1", skillIds: ["missing"] });
      expect(jsonMessages(input).filter(({ kind }) => kind === "runtime_child_result")).toEqual([]);
      expect(JSON.stringify(jsonMessages(input))).toContain(
        "knowledge_skill_not_found",
      );
      expect(JSON.stringify(jsonMessages(input))).not.toContain(
        document.content,
      );
    },
    decide() { throw new Error("unexpected_routing_after_direct_procedure_gate"); },
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
      selection += 1;
      return { action: "read_skills", skillIds: [document.skillId] };
    },
    classifyProcedure(input) {
      assertNoSkillGuidance(input, [document]);
      return { requiresProcedure: true };
    },
    delegate(input) {
      assertNoSkillGuidance(input, [document]);
      return { action: "invoke_role", roleId: "planner", objective };
    },
    decide(input) {
      if (typeof input.format === "object" && input.format?.name === "supervisor_working_directory")
        return JSON.stringify({ workingDirectory: "." });
      expect(JSON.stringify(jsonMessages(input))).toContain(document.content);
      if (input.modelStep === "supervisor.decision") {
        expect(++supervisor).toBe(1);
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
      if (input.modelStep === "worker.evidence") return workerEvidenceDecision(input, false);
      expect(input.modelStep).toBe("worker.result");
      return "The owner controls state and the adapter executes effects.";
    },
  });
  await expect(runRequestRunner(attachStore(harness.request, store))).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(store.read).toHaveBeenCalledExactlyOnceWith(document.skillId);
  expect(selection).toBe(1);
  expect(harness.request.onAcknowledgement).toHaveBeenCalledOnce();
  expect(harness.gatewayInvoke.mock.calls.filter(([input]) => input.modelStep === "worker.evidence")).toHaveLength(1);
  for (const [input] of harness.gatewayInvoke.mock.calls) {
    const assignments = jsonMessages(input).filter(({ kind }) => String(kind).includes("assignment"));
    for (const assignment of assignments) expect(assignment.objective).toBe(objective);
  }
});
