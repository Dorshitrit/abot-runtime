import { afterEach, beforeEach, expect, test } from "vitest";
import { projectOllamaFormat, toOpenAIResponsesTextFormat } from "../../model-gateway/structured-output.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";
import { parseSkillReadDecision } from "../steps/skill-read-decision.js";
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
const ELIGIBLE_SKILL_IDS = Object.freeze(["computer-use", "מדריך-יומי", "a"]);
const parse = (decision: unknown, eligibleIds: readonly string[] = ELIGIBLE_SKILL_IDS) =>
  parseSupervisorSkillSelectionOutput(JSON.stringify({ decision }), eligibleIds);

test("Skill selection accepts continue and multi-READ without a Worker role or working directory", () => {
  expect(parse({ action: "continue" })).toEqual({ ok: true, decision: { action: "continue" } });
  expect(parse({ action: "read_skills", skillIds: ["computer-use", "מדריך-יומי"] })).toEqual({
    ok: true, decision: { action: "read_skills", skillIds: ["computer-use", "מדריך-יומי"] },
  });
});

test("Skill selection accepts the full eight-ID bound without changing order", () => {
  const eligibleIds = Array.from({ length: 8 }, (_, index) => `guide-${index}`);
  const skillIds = [...eligibleIds].reverse();
  expect(parse({ action: "read_skills", skillIds }, eligibleIds)).toEqual({
    ok: true, decision: { action: "read_skills", skillIds },
  });
  const nineIds = [...eligibleIds, "ninth-guide"];
  expect(parse({ action: "read_skills", skillIds: nineIds }, nineIds)).toMatchObject({
    ok: false, stage: "domain_parser", issues: [{ code: "skill_read_references_invalid" }],
  });
});

test.each(["Computer Use", "unknown-guide", "Computer-use", "already-read-guide"])(
  "Skill selection atomically rejects a mixed batch containing ineligible ID %s", (ineligibleId) => {
    const skillIds = Object.freeze(["computer-use", ineligibleId]);
    const result = parse({ action: "read_skills", skillIds });
    expect(result).toEqual({
      ok: false, stage: "domain_parser", issues: [{
        code: "skill_selection_ids_ineligible", path: "decision.skillIds",
        message: expect.any(String),
      }],
    });
    expect(result).not.toHaveProperty("decision");
    expect(skillIds).toEqual(["computer-use", ineligibleId]);
  },
);

test.each([{ skillIds: [] }, { skillIds: [" a"] }, { skillIds: [7] }])(
  "Skill selection repair guidance stays IDs-only for malformed references %j", ({ skillIds }) => {
    const parsed = parse({ action: "read_skills", skillIds });
    expect(parsed).toMatchObject({
      ok: false, stage: "domain_parser", issues: [{
        code: "skill_read_references_invalid", path: "decision.skillIds",
      }],
    });
    if (parsed.ok) throw new Error("expected_invalid_skill_selection");
    for (const issue of parsed.issues) {
      expect(issue.message).toMatch(/\bIDs\b/u);
      expect(issue.message).not.toMatch(/\bnames?\b/iu);
    }
  },
);

test("SUPER distinguishes an eligible duplicate batch without normalizing or accepting its IDs", () => {
  const skillIds = Object.freeze(["computer-use", "a", "computer-use"]);
  expect(parse({ action: "read_skills", skillIds })).toMatchObject({
    ok: false, stage: "domain_parser",
    issues: [{ code: "skill_selection_ids_duplicate", path: "decision.skillIds" }],
  });
  expect(skillIds).toEqual(["computer-use", "a", "computer-use"]);
});

test.each([
  { skillIds: ["a", "a", "unknown-guide"] },
  { skillIds: ["a", "a", "already-read-guide"] },
  { skillIds: [" a", " a"] },
  { skillIds: Array.from({ length: 9 }, () => "a") },
])("a duplicate with another invalid reference is not an eligible-only duplicate: %j", ({ skillIds }) => {
  expect(parse({ action: "read_skills", skillIds })).toMatchObject({
    ok: false, stage: "domain_parser", issues: [{ code: "skill_read_references_invalid" }],
  });
});

test("a duplicate cannot bypass the SUPER action shape contract", () => {
  expect(parse({ action: "read_skills", skillIds: ["a", "a"], objective: "Extra work." })).toMatchObject({
    ok: false, issues: [{ code: "skill_read_shape_invalid" }],
  });
});

test.each([
  { skillIds: ["a", "a"] }, { skillIds: ["Full Skill Name", "Full Skill Name"] },
  { skillIds: [] }, { skillIds: [" a"] }, { skillIds: [7] },
  { skillIds: Array.from({ length: 9 }, (_, index) => `guide-${index}`) },
])("the shared Skill parser preserves its existing invalid-reference classification: %j", ({ skillIds }) => {
  expect(parseSkillReadDecision({ action: "read_skills", skillIds }, {
    allowSkillReads: true, acknowledgementMaxLength: 0, titleMaxLength: 0,
  })).toMatchObject({
    ok: false, stage: "domain_parser",
    issues: [{ code: "skill_read_references_invalid", path: "decision.skillIds" }],
  });
});

test("the shared Skill parser preserves valid full-name reads and the unavailable gate", () => {
  const decision = { action: "read_skills", skillIds: ["Full Skill Name", "a"] };
  const options = { acknowledgementMaxLength: 0, titleMaxLength: 0 };
  expect(parseSkillReadDecision(decision, { ...options, allowSkillReads: true })).toEqual({ ok: true, decision });
  expect(parseSkillReadDecision({ action: "read_skills", skillIds: ["a", "a"] }, options)).toMatchObject({
    ok: false, issues: [{ code: "skill_read_unavailable" }],
  });
});

test("Skill selection preserves exact IDs without decoding or normalization", () => {
  const eligibleIds = ["guide%2Fone", "מדריך-יומי"];
  expect(parse({ action: "read_skills", skillIds: eligibleIds }, eligibleIds).ok).toBe(true);
  expect(parse({ action: "read_skills", skillIds: ["guide/one"] }, eligibleIds)).toMatchObject({
    ok: false, issues: [{ code: "skill_selection_ids_ineligible" }],
  });
});

test("Skill selection permits only continue when no candidate is eligible", () => {
  expect(parse({ action: "continue" }, [])).toEqual({ ok: true, decision: { action: "continue" } });
  expect(parse({ action: "read_skills", skillIds: ["computer-use"] }, [])).toMatchObject({
    ok: false, issues: [{ code: "skill_selection_ids_ineligible" }],
  });
  const format = createSupervisorSkillSelectionFormat([]);
  expect(format.schema).toMatchObject({
    properties: { decision: { properties: { action: { enum: ["continue"] } }, required: ["action"] } },
  });
  expect(JSON.stringify(format.schema)).not.toContain('"read_skills"');
  expect(JSON.stringify(format.schema)).not.toContain('"enum":[]');
  expect(() => projectOllamaFormat(format)).not.toThrow();
  expect(() => toOpenAIResponsesTextFormat(format)).not.toThrow();
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
  const format = createSupervisorSkillSelectionFormat(ELIGIBLE_SKILL_IDS);
  expect(format.schema).toMatchObject({
    properties: { decision: { anyOf: [
      { properties: { action: { enum: ["continue"] } } },
      { properties: {
        action: { enum: ["read_skills"] },
        skillIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", enum: ELIGIBLE_SKILL_IDS } },
      }, required: ["action", "skillIds"], additionalProperties: false },
    ] } },
  });
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
  const messages = input.context.messages.map((message) => message.content).join("\n");
  expect(messages).toContain('"skillId":"private-guide"');
  expect(messages).toContain('"description":"Exact formatting conventions."');
  expect(messages).not.toContain("SECRET_BODY_BEFORE_READ");
  expect(JSON.stringify(input.format)).not.toContain('"roleId"');
});
