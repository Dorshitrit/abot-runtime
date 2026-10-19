import { afterEach, beforeEach, expect, test } from "vitest";
import { projectOllamaFormat, toOpenAIResponsesTextFormat } from "../../model-gateway/structured-output.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";
import { buildSupervisorSkillSelectionInput } from "../steps/supervisor-decision/skill-selection-input.js";
import { createSupervisorSkillSelectionFormat, parseSupervisorSkillSelectionOutput } from "../steps/supervisor-decision/skill-selection.js";
import { createSupervisorPresentationFormat, parseSupervisorPresentationOutput } from "../steps/supervisor-decision/presentation.js";
import { createKnowledgeSkillStore } from "../knowledge-skills/store.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());
const parse = (decision: unknown) => parseSupervisorSkillSelectionOutput(JSON.stringify({ decision }));

test("Skill selection accepts continue and multi-READ without a Worker role or working directory", () => {
  expect(parse({ action: "continue" })).toEqual({ ok: true, decision: { action: "continue" } });
  expect(parse({ action: "read_skills", skillIds: ["computer-use", "סיכום יומי"] })).toEqual({
    ok: true, decision: { action: "read_skills", skillIds: ["computer-use", "סיכום יומי"] },
  });
});

test("Skill selection rejects LIST even when a model emits the former valid action", () => {
  expect(parse({ action: "list_skills" })).toMatchObject({
    ok: false, stage: "domain_parser", issues: [{ code: "skill_selection_action_invalid" }],
  });
});

test.each([
  { action: "read_skills", skillIds: [] },
  { action: "read_skills", skillIds: ["a", "a"] },
  { action: "read_skills", skillIds: Array.from({ length: 9 }, (_, i) => `skill-${i}`) },
  { action: "read_skills", skillIds: [" a"] },
  { action: "read_skills", skillIds: ["a"], objective: "extra assignment" },
  { action: "list_skills", skillIds: [] },
])("rejects malformed core read input: %j", (decision) => {
  expect(parse(decision).ok).toBe(false);
});

test.each([{ action: "list_skills" }, { action: "read_skills", skillIds: ["a"] }])(
  "unavailable core reads are rejected even without tool authority: %j", (decision) => {
    expect(parseSupervisorDecisionOutput(JSON.stringify({ decision }), { allowedRoleIds: [] })).toMatchObject({
      ok: false, stage: "domain_parser",
    });
  },
);

test("Skill selection schemas preserve provider projection without presentation or routing fields", () => {
  const format = createSupervisorSkillSelectionFormat();
  expect(JSON.stringify(format.schema)).not.toContain('"list_skills"');
  expect(JSON.stringify(format.schema)).toContain('"read_skills"');
  expect(JSON.stringify(format.schema)).toContain('"continue"');
  for (const field of ["acknowledgement", "title", "objective", "invoke_role", "respond"])
    expect(JSON.stringify(format.schema)).not.toContain(`"${field}"`);
  expect(() => projectOllamaFormat(format)).not.toThrow();
  expect(() => toOpenAIResponsesTextFormat(format)).not.toThrow();
  expect(JSON.stringify(createSupervisorDecisionFormat({ allowedRoleIds: [] }).schema)).not.toContain('"read_skills"');
});

test.each([
  { action: "continue", acknowledgement: "Starting now." },
  { action: "read_skills", skillIds: ["a"], title: "A title" },
  { action: "invoke_role", roleId: "worker", objective: "Do work." },
])("Skill selection rejects unrelated responsibility: %j", decision => {
  expect(parse(decision).ok).toBe(false);
});

test.each([false, true])("presentation contains exactly requested fields, title=%s", includeTitle => {
  const options = { includeAcknowledgement: true, includeTitle };
  const decision = { acknowledgement: "Starting now.", ...(includeTitle ? { title: "Requested work" } : {}) };
  expect(parseSupervisorPresentationOutput(JSON.stringify({ decision }), options)).toEqual({ ok: true, decision });
  expect(parseSupervisorPresentationOutput(JSON.stringify({ decision: { ...decision, action: "read_skills" } }), options).ok).toBe(false);
  expect(parseSupervisorPresentationOutput(JSON.stringify({ decision: { ...decision, skillIds: ["a"] } }), options).ok).toBe(false);
  const format = createSupervisorPresentationFormat(options);
  expect(() => projectOllamaFormat(format)).not.toThrow();
  expect(() => toOpenAIResponsesTextFormat(format)).not.toThrow();
});

test("SUPER exposes Store metadata independently of Worker and tool slots, without document bodies", async () => {
  const fixture = await createControlsEvidenceFixture();
  const store = createKnowledgeSkillStore([{
    skillId: "private-guide", name: "Private guide", description: "Exact formatting conventions.", content: "SECRET_BODY_BEFORE_READ",
  }]);
  const request = createRequestExecutionScope({
    seed: fixture.request, knowledgeSkillStore: store,
    executionPolicy: SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
    createWorkerCapabilities: () => fixture.request.workerCapabilities.provider,
  });
  expect(request.knowledgeSkillStore).toBe(store);
  expect(request.workerCapabilities.executionContext).not.toHaveProperty("knowledgeSkillStore");
  const input = buildSupervisorSkillSelectionInput(request, {});
  const messages = JSON.stringify(input.context.messages);
  expect(messages).toContain("[private-guide]:");
  expect(messages).not.toContain("SECRET_BODY_BEFORE_READ");
  expect(JSON.stringify(input.format)).not.toContain('"roleId"');
});
