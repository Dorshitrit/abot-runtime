import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { projectOllamaFormat, toOpenAIResponsesTextFormat } from "../../model-gateway/structured-output.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createSupervisorDelegationFormat,
  parseSupervisorDelegationOutput,
  type SupervisorDelegationOptions,
} from "../steps/supervisor-decision/delegation-contract.js";
import { ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH } from "../orchestration/role-calls/memory-recall-contract.js";
import { SUPERVISOR_OBJECTIVE_MAX_LENGTH } from "../steps/supervisor-decision/contracts.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { vi.restoreAllMocks(); resetDebugLoggerConfig(); });

const parse = (decision: unknown, options: Parameters<typeof parseSupervisorDelegationOutput>[1] = {}) =>
  parseSupervisorDelegationOutput(JSON.stringify({ decision }), options);
const invocation = (roleId: string) => ({ action: "invoke_role", roleId, objective: "Perform the requested procedure." });

test("delegation has one exact Worker/Planner branch without tool or presentation choices", () => {
  const format = createSupervisorDelegationFormat();
  expect(format).toMatchObject({ type: "json_schema", name: "supervisor_delegation", strict: true });
  const variants = decisionVariants(format.schema);
  expect(variants).toHaveLength(1);
  expect(variants[0]).toEqual({
    type: "object", additionalProperties: false,
    required: ["action", "roleId", "objective"],
    properties: {
      action: { type: "string", enum: ["invoke_role"] },
      roleId: { type: "string", enum: ["planner", "worker"] },
      objective: { type: "string", minLength: 1, maxLength: SUPERVISOR_OBJECTIVE_MAX_LENGTH },
    },
  });
  for (const field of ["respond", "author_skill", "recall_memory", "reviewer", "workingDirectory", "workerCapabilityScope", "catalogGroupIds", "acknowledgement", "title", "responseRecommendation"])
    expect(JSON.stringify(format.schema)).not.toContain(`"${field}"`);
  expect(format.postValidatedSchemaConstraints).toEqual([
    { keyword: "maxLength", path: "/properties/decision/properties/objective/maxLength" },
  ]);
});

test.each(["worker", "planner"])("the native parser accepts the existing unscoped %s contract", (roleId) => {
  const decision = invocation(roleId);
  const canonical = parseSupervisorDecisionOutput(JSON.stringify({ decision }), {
    allowedRoleIds: ["worker", "planner"], availableWorkerCapabilityCatalog: [],
  });
  expect(parse(decision)).toEqual(canonical);
  expect(parse(decision)).toEqual({ ok: true, decision });
});

test("role availability is intersected with Worker/Planner and preserves canonical deduplication", () => {
  const options = { allowedRoleIds: ["worker", "reviewer", "worker"] as const };
  expect(decisionVariants(createSupervisorDelegationFormat(options).schema)[0]).toMatchObject({
    properties: { roleId: { enum: ["worker"] } },
  });
  expect(parse(invocation("worker"), options).ok).toBe(true);
  expect(parse(invocation("planner"), options)).toMatchObject({
    ok: false, stage: "domain_parser", issues: [{ code: "supervisor_role_invalid", path: "decision.roleId" }],
  });
  expect(parse({ action: "invoke_role", roleId: "reviewer" }, options)).toMatchObject({
    ok: false, issues: [{ code: "supervisor_role_invalid" }],
  });
});

test.each([
  { allowedRoleIds: [] },
  { allowedRoleIds: ["reviewer"] },
] satisfies SupervisorDelegationOptions[])("no offered action produces a closed format boundary: %j", (options) => {
  expect(() => createSupervisorDelegationFormat(options)).toThrow("supervisor_delegation_actions_unavailable");
  expect(parse(invocation("worker"), options).ok).toBe(false);
  expect(parse({ action: "respond" }, options).ok).toBe(false);
});

test("eligible initial delegation accepts only the canonical root recall action", () => {
  const options = { allowedRoleIds: ["worker", "planner"] as const, allowMemoryRecall: true, allowSkillAuthoring: true };
  const decision = { action: "recall_memory", query: "Relevant prior facts." };
  expect(parse(decision, options)).toEqual(parseSupervisorDecisionOutput(JSON.stringify({ decision }), options));
  expect(parse(decision, options)).toEqual({ ok: true, decision });
  expect(parse(decision).ok).toBe(false);
  expect(parse(decision, { ...options, allowMemoryRecall: false }).ok).toBe(false);
  expect(parse({ action: "author_skill" }, options).ok).toBe(false);
  expect(JSON.stringify(createSupervisorDelegationFormat(options).schema)).not.toContain('"author_skill"');
});

test("recall schema and bounds reuse the canonical contract without adding other root actions", () => {
  const options = { allowedRoleIds: ["worker"] as const, allowMemoryRecall: true, allowSkillAuthoring: true };
  const format = createSupervisorDelegationFormat(options);
  const variants = decisionVariants(format.schema);
  const canonical = decisionVariants(createSupervisorDecisionFormat({ ...options, allowSkillAuthoring: false }).schema);
  expect(variants).toEqual(canonical.slice(1));
  expect(variants).toHaveLength(2);
  expect(variants[1]).toMatchObject({
    required: ["action", "query"], additionalProperties: false,
    properties: { action: { enum: ["recall_memory"] }, query: { maxLength: ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH } },
  });
  expect(format.postValidatedSchemaConstraints).toEqual([
    { keyword: "maxLength", path: "/properties/decision/anyOf/1/properties/query/maxLength" },
    { keyword: "maxLength", path: "/properties/decision/anyOf/0/properties/objective/maxLength" },
  ]);
});

test.each([
  { query: "" }, { query: "   " }, { query: 7 },
  { query: "x".repeat(ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH + 1) },
  { query: "A relevant subject.", objective: "Do work instead." },
  { query: "A relevant subject.", acknowledgement: "Starting." },
])("recall remains bounded and exact even without provider schema enforcement: %j", fields => {
  expect(parse({ action: "recall_memory", ...fields }, { allowMemoryRecall: true }).ok).toBe(false);
});

test.each([
  {},
  { allowedRoleIds: ["worker"] },
  { allowedRoleIds: ["planner"] },
  { allowedRoleIds: ["worker", "planner"] },
  { allowedRoleIds: ["worker"], allowMemoryRecall: true },
  { allowedRoleIds: ["planner"], allowMemoryRecall: true },
  { allowedRoleIds: ["worker", "planner"], allowMemoryRecall: true },
] satisfies SupervisorDelegationOptions[])("provider schemas retain valid post-validation paths: %j", (options) => {
  const format = createSupervisorDelegationFormat(options);
  for (const constraint of format.postValidatedSchemaConstraints ?? [])
    expect(readSchemaPointer(format.schema, constraint.path)).toEqual(expect.any(Number));
  const ollama = projectOllamaFormat(format);
  const removals = ollama.diagnostics.map(({ keyword, path }) => ({ keyword, path }));
  expect(removals).toHaveLength(format.postValidatedSchemaConstraints?.length ?? 0);
  expect(removals).toEqual(expect.arrayContaining([...(format.postValidatedSchemaConstraints ?? [])]));
  for (const constraint of format.postValidatedSchemaConstraints ?? [])
    expect(readSchemaPointer(ollama.format as Record<string, unknown>, constraint.path)).toBeUndefined();
  expect(toOpenAIResponsesTextFormat(format)).toEqual({
    type: "json_schema", name: "supervisor_delegation", strict: true, schema: format.schema,
  });
});

test.each([
  { workerCapabilityScope: { catalogGroupIds: ["filesystem"] } },
  { workingDirectory: "/tmp" },
  { acknowledgement: "Starting." },
  { title: "Procedure" },
  { responseRecommendation: "Reply immediately." },
  { capabilityId: "write_complete_file" },
])("the native parser rejects unrelated fields even if schema enforcement is bypassed: %j", (fields) => {
  expect(parse({ ...invocation("worker"), ...fields })).toMatchObject({
    ok: false, stage: "domain_parser", issues: [{ code: "supervisor_decision_shape_invalid" }],
  });
});

test.each(["respond", "invoke_capability", "read_skills", "unknown_action"])(
  "the native parser cannot leave delegation through %s", (action) => {
    expect(parse({ action }).ok).toBe(false);
  },
);

test("respond is rejected without a misleading accepted-decision trace", () => {
  configureDebugLogger({ enabled: true });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(parseSupervisorDelegationOutput(JSON.stringify({ decision: { action: "respond" } }), {
    diagnostic: { requestId: "delegation-request", modelStep: "supervisor.decision", decisionPhase: "routing" },
  })).toMatchObject({
    ok: false, stage: "domain_parser",
    issues: [{ code: "supervisor_delegation_action_invalid", path: "decision.action" }],
  });
  const logs = output.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string });
  expect(logs.map(({ event }) => event)).toEqual(["output.envelope.accepted", "decision.rejected"]);
});

test.each(["not JSON", "[]", '{"action":"invoke_role"}', '{"decision":{"action":"respond"},"extra":1}'])(
  "envelope failures keep the canonical parser's classification: %s", (text) => {
    expect(parseSupervisorDelegationOutput(text)).toEqual(parseSupervisorDecisionOutput(text));
  },
);

test.each([
  { name: "empty", objective: "" },
  { name: "blank", objective: "   " },
  { name: "oversized", objective: "x".repeat(SUPERVISOR_OBJECTIVE_MAX_LENGTH + 1) },
  { name: "non-string", objective: 123 },
])(
  "objective bounds remain enforced after provider annotation removal: $name", ({ objective }) => {
    expect(parse({ ...invocation("worker"), objective })).toMatchObject({
      ok: false, issues: [{ code: "supervisor_objective_invalid", path: "decision.objective" }],
    });
  },
);

test("root availability cannot rescue a delegation with no Worker or Planner", () => {
  const options = { allowedRoleIds: [] as const, allowMemoryRecall: true, allowSkillAuthoring: true };
  expect(() => createSupervisorDelegationFormat(options)).toThrow("supervisor_delegation_actions_unavailable");
  expect(parse({ action: "author_skill" }, options).ok).toBe(false);
  expect(parse({ action: "recall_memory", query: "Prior facts." }, options).ok).toBe(false);
});

function decisionVariants(schema: Record<string, unknown>): Record<string, unknown>[] {
  const decision = (schema.properties as Record<string, unknown>).decision as Record<string, unknown>;
  return (decision.anyOf as Record<string, unknown>[] | undefined) ?? [decision];
}

function readSchemaPointer(schema: Record<string, unknown>, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, schema);
}
