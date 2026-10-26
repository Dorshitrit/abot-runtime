import { workerEvidenceDecision } from "./support/worker-evidence-script.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { KnowledgeSkillDocument, KnowledgeSkillStore } from "../knowledge-skills/store.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { prepareSupervisorDecision } from "../steps/supervisor-decision/preparation.js";
import { activeCoreSkillCall, commitSkillFixture, createCoreSkillContextFixture } from "./support/core-skill-read-context-fixture.js";
import { createMemoryRecallHarness, FINAL_RESPONSE, jsonMessages } from "./support/memory-recall-runner.js";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";

const guide: KnowledgeSkillDocument = {
  skillId: "first-guide", name: "First guide", description: "Task conventions.",
  source: "personal", revision: 1, content: "CAPTURED_GUIDANCE: preserve accepted scope.",
};
const secondGuide = { ...guide, skillId: "second-guide", name: "Second guide", content: "SECOND_GUIDANCE: name the owning layer." };
type Harness = ReturnType<typeof createMemoryRecallHarness>;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

function attachStore(harness: Harness, store: KnowledgeSkillStore, requestId = harness.request.requestId) {
  return createRequestExecutionScope({
    seed: { ...harness.request, requestId }, executionPolicy: harness.request.executionPolicy,
    knowledgeSkillStore: store, createWorkerCapabilities: () => harness.request.workerCapabilities.provider,
  });
}

function skillEvents(harness: Harness) {
  return vi.mocked(harness.request.onEvent).mock.calls.filter(([type, state]) =>
    type === "runtime.state" && (state as { phase?: string }).phase === "skills");
}

test("a captured legacy LIST failure still suppresses selection without another model call", async () => {
  const fixture = await createCoreSkillContextFixture();
  const call = activeCoreSkillCall(fixture.ledger);
  await commitSkillFixture(fixture.ledger, {
    authority: "runtime", type: "record_skill_read", callId: call.callId,
    invocationAttempt: call.activationCount, steeringVersion: 0,
    operation: "list_skills", selectors: [],
    result: { outcome: "failed", errorCode: "knowledge_skill_storage_unavailable", skills: [] },
  });
  await expect(prepareSupervisorDecision(fixture.request, {
    includeAcknowledgement: false, includeTitle: false, allowSkillReads: true,
    skillReadHead: fixture.ledger.current(),
    skillSelectionWindow: fixture.request.supervisorSkillSelectionWindows.bind({ rootCallId: call.callId }), diagnostic: {
      requestId: fixture.request.requestId, modelStep: "supervisor.decision", decisionPhase: "skill_selection",
      callId: call.callId, parentCallId: null, depth: 0, invocationAttempt: call.activationCount,
    },
  })).resolves.toMatchObject({ presentation: {}, selection: { action: "continue" } });
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test("a failed read after child return suppresses later selection while retaining prior guidance", async () => {
  let selections = 0;
  let routes = 0;
  let workers = 0;
  const store = {
    list: vi.fn(() => [guide, { ...guide, skillId: "missing-guide", name: "Removed after selection" }]),
    read: vi.fn((id: string) => id === guide.skillId ? guide : undefined),
  };
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills() {
      return { action: "read_skills", skillIds: [++selections === 1 ? guide.skillId : "missing-guide"] };
    },
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate(input) {
      expect(JSON.stringify(input.messages)).not.toContain(guide.content);
      expect(selections).toBe(++routes);
      return { action: "invoke_role", roleId: "worker", objective: "Explain the owning layer." };
    },
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory")
        return JSON.stringify({ workingDirectory: "." });
      expect(JSON.stringify(input.messages)).toContain(guide.content);
      if (input.modelStep === "worker.result") return "The runtime owns canonical state.";
      if (input.modelStep === "worker.evidence") {
        workers++;
        expect(harness.requestSteering.append({ steerId: `after-worker-${workers}`, text: `Finish after Worker ${workers}.` }).ok).toBe(true);
        return workerEvidenceDecision(input, false);
      }
      expect(input.modelStep).toBe("supervisor.decision");
      routes++;
      expect(jsonMessages(input).some(({ kind }) => kind === "runtime_child_result")).toBe(true);
      if (routes === 2) {
        expect(selections).toBe(2);
        expect(JSON.stringify(input.messages)).toContain("knowledge_skill_not_found");
        return { action: "invoke_role", roleId: "worker", objective: "Check the explanation using the captured guide." };
      }
      expect(routes).toBe(3);
      expect(JSON.stringify(input.messages)).toContain("Finish after Worker 2.");
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(attachStore(harness, store))).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(2);
  expect(routes).toBe(3);
  expect(store.read.mock.calls).toEqual([[guide.skillId], ["missing-guide"]]);
  expect(harness.gatewayInvoke.mock.calls.filter(([input]) => input.modelStep === "worker.evidence")).toHaveLength(2);
  expect(JSON.stringify(harness.gatewayInvoke.mock.calls.at(-1)![0].messages)).toContain(guide.content);
  expect(skillEvents(harness)).toEqual([
    ["runtime.state", { stage: "supervisor", phase: "skills", message: "Read Skills: First guide" }],
    ["runtime.state", { stage: "supervisor", phase: "skills", message: "Skill lookup failed: knowledge_skill_not_found" }],
  ]);
});

test.each([false, true])("a new request can read the same Skill after a prior request (available: %s)", async (initiallyAvailable) => {
  let available = initiallyAvailable;
  const store = { list: vi.fn(() => [guide]), read: vi.fn(() => available ? guide : undefined) };
  const failedSelection = vi.fn(() => ({ action: "read_skills", skillIds: [guide.skillId] }));
  const first = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false, selectSkills: failedSelection,
    decide: () => ({ action: "respond" }),
  });
  await expect(runRequestRunner(attachStore(first, store, "first-request"))).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(failedSelection).toHaveBeenCalledOnce();
  available = true;
  let selections = 0;
  const next = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills: () => ++selections === 1
      ? { action: "read_skills", skillIds: [guide.skillId] } : { action: "continue" },
    classifyProcedure(input) {
      expect(JSON.stringify(input.messages)).not.toContain(guide.content);
      return { requiresProcedure: false, responseRecommendation: "Answer the request using the guide." };
    },
    onInput(input) {
      if (input.modelStep === "supervisor.response") expect(JSON.stringify(input.messages)).toContain(guide.content);
    },
    decide: vi.fn(),
  });
  expect(first.request.sessionId).toBe(next.request.sessionId);
  await expect(runRequestRunner(attachStore(next, store, "next-request"))).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(1);
  expect(store.read.mock.calls).toEqual([[guide.skillId], [guide.skillId]]);
  expect(skillEvents(next)).toEqual([["runtime.state", {
    stage: "supervisor", phase: "skills", message: "Read Skills: First guide",
  }]]);
});

test("a child return permits one additional Skill batch in the same request", async () => {
  const documents = [guide, secondGuide];
  const store = {
    list: vi.fn(() => documents),
    read: vi.fn((id: string) => documents.find(({ skillId }) => id === skillId)),
  };
  let selections = 0;
  let routes = 0;
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1", enabled: false,
    selectSkills() {
      const target = documents[selections++];
      expect(target).toBeDefined();
      return { action: "read_skills", skillIds: [target!.skillId] };
    },
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate(input) {
      expect(JSON.stringify(input.messages)).not.toContain(guide.content);
      expect(selections).toBe(++routes);
      return { action: "invoke_role", roleId: "worker", objective: "Apply the first guide." };
    },
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory")
        return JSON.stringify({ workingDirectory: "." });
      expect(JSON.stringify(input.messages)).toContain(guide.content);
      if (input.modelStep === "worker.evidence") return workerEvidenceDecision(input, false);
      if (input.modelStep === "worker.result") return "The first guide was applied.";
      expect(input.modelStep).toBe("supervisor.decision");
      routes++;
      expect(routes).toBe(2);
      expect(jsonMessages(input).some(({ kind }) => kind === "runtime_child_result")).toBe(true);
      for (const { content } of documents) expect(JSON.stringify(input.messages)).toContain(content);
      return { action: "respond" };
    },
  });
  await expect(runRequestRunner(attachStore(harness, store))).resolves.toMatchObject({ output: FINAL_RESPONSE });
  expect(selections).toBe(2);
  expect(routes).toBe(2);
  expect(store.read.mock.calls).toEqual(documents.map(({ skillId }) => [skillId]));
  expect(skillEvents(harness)).toEqual(documents.map(({ name }) => ["runtime.state", {
    stage: "supervisor", phase: "skills", message: `Read Skills: ${name}`,
  }]));
});
