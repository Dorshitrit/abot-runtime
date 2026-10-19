import { describe, expect, test } from "vitest";
import {
  parseRoleCallWorkerCapabilityScope,
  ROLE_CALL_WORKER_CAPABILITY_CATALOG_GROUP_LIMIT,
} from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityCatalogGroup } from "../orchestration/worker-capabilities/index.js";
import {
  createWorkerCapabilityScopeDecisionContract,
  parseWorkerCapabilityScopeDecision,
} from "../steps/worker-capability-scope-decision.js";
import { parsePlannerDecisionOutput } from "../steps/planner-decision/parser.js";
import { parseSupervisorDecisionOutput } from "../steps/supervisor-decision/parser.js";

function catalog(ids: readonly string[]): readonly WorkerCapabilityCatalogGroup[] {
  return ids.map((groupId) => ({
    groupId,
    memberCount: 1,
    effects: ["mutation"],
  }));
}

const availableCatalog = catalog(["read", "write"]);
const contract = createWorkerCapabilityScopeDecisionContract(availableCatalog);
const repeatedScope = { catalogGroupIds: ["write", "read", "write", "read"] };
const normalizedScope = { catalogGroupIds: ["write", "read"] };

function parseRoleDecision(
  role: "planner" | "supervisor",
  scope: unknown,
  offeredCatalog = availableCatalog,
) {
  const decision = {
    action: "invoke_role",
    roleId: "worker",
    objective: "Create the requested artifact.",
    ...(scope === undefined ? {} : { workerCapabilityScope: scope }),
  };
  return role === "planner"
    ? parsePlannerDecisionOutput(
        JSON.stringify({ decision: { ...decision, workingDirectory: "." } }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: offeredCatalog,
        },
      )
    : parseSupervisorDecisionOutput(JSON.stringify({ decision }), {
        allowedRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: offeredCatalog,
      });
}

describe("Worker scope model-output normalization", () => {
  test("preserves first occurrence order and does not mutate the model selection", () => {
    const original = structuredClone(repeatedScope);
    const parsed = parseWorkerCapabilityScopeDecision(repeatedScope, contract);
    expect(parsed).toEqual(normalizedScope);
    expect(repeatedScope).toEqual(original);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.catalogGroupIds)).toBe(true);
    expect(parseWorkerCapabilityScopeDecision(normalizedScope, contract)).toEqual(
      normalizedScope,
    );
  });

  test("keeps the canonical scope parser strict", () => {
    expect(parseRoleCallWorkerCapabilityScope(repeatedScope)).toBeUndefined();
    const normalized = parseWorkerCapabilityScopeDecision(repeatedScope, contract);
    expect(parseRoleCallWorkerCapabilityScope(normalized)).toEqual(normalizedScope);
  });

  test.each([
    null,
    undefined,
    [],
    "write",
    {},
    { catalogGroupIds: "write" },
    { catalogGroupIds: [] },
    { catalogGroupIds: ["unknown", "unknown"] },
    { catalogGroupIds: ["write", "unknown", "write"] },
    { catalogGroupIds: [" write", " write"] },
    { catalogGroupIds: ["write", null, "write"] },
    { catalogGroupIds: [1, 1] },
    { catalogGroupIds: [{ groupId: "write" }] },
    { catalogGroupIds: ["write", "write"], extra: true },
    Object.create({ catalogGroupIds: ["write", "write"] }),
  ])("still rejects malformed or unoffered scope %j", (scope) => {
    expect(parseWorkerCapabilityScopeDecision(scope, contract)).toBeUndefined();
  });

  test("applies the existing scope bound after repeated selections are removed", () => {
    const ids = Array.from(
      { length: ROLE_CALL_WORKER_CAPABILITY_CATALOG_GROUP_LIMIT + 1 },
      (_, index) => `group-${index}`,
    );
    const boundedContract = createWorkerCapabilityScopeDecisionContract(catalog(ids));
    const withinLimit = ids.slice(0, ROLE_CALL_WORKER_CAPABILITY_CATALOG_GROUP_LIMIT);
    expect(parseWorkerCapabilityScopeDecision({
      catalogGroupIds: [...withinLimit, ...withinLimit],
    }, boundedContract)).toEqual({ catalogGroupIds: withinLimit });
    expect(parseWorkerCapabilityScopeDecision({
      catalogGroupIds: [...ids, ...ids],
    }, boundedContract)).toBeUndefined();
  });

  test("does not create a scope when no catalog is offered", () => {
    const empty = createWorkerCapabilityScopeDecisionContract([]);
    expect(empty).toEqual({ catalogGroupIds: [], required: false });
    expect(parseWorkerCapabilityScopeDecision(repeatedScope, empty)).toBeUndefined();
  });
});

describe.each(["planner", "supervisor"] as const)("%s decision scope", (role) => {
  test("accepts repeated offered IDs before canonical child admission", () => {
    expect(parseRoleDecision(role, repeatedScope)).toMatchObject({
      ok: true,
      decision: { workerCapabilityScope: normalizedScope },
    });
    expect(parseRoleDecision(role, normalizedScope)).toMatchObject({
      ok: true,
      decision: { workerCapabilityScope: normalizedScope },
    });
  });

  test.each([
    undefined,
    { catalogGroupIds: [] },
    { catalogGroupIds: ["write", "unknown", "write"] },
    { catalogGroupIds: ["write", false, "write"] },
    { catalogGroupIds: ["write", "write"], extra: true },
  ])("preserves domain rejection for invalid scope %j", (scope) => {
    expect(parseRoleDecision(role, scope)).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: expect.arrayContaining([expect.objectContaining({
        code: `${role}_worker_capability_scope_invalid`,
        path: "decision.workerCapabilityScope.catalogGroupIds",
      })]),
    });
  });

  test("preserves empty-catalog scope admission rules", () => {
    expect(parseRoleDecision(role, undefined, [])).toMatchObject({ ok: true });
    expect(parseRoleDecision(role, repeatedScope, [])).toMatchObject({
      ok: false,
      stage: "domain_parser",
    });
  });
});

test("a Planner plan with repeated group IDs retains its declaration and selected item", () => {
  const items = ["index.html", "styles.css", "app.js", "products.json"].map((file) => ({
    title: `Create ${file}`,
    objective: `Create the requested ${file} artifact.`,
  }));
  const parsed = parsePlannerDecisionOutput(JSON.stringify({
    decision: {
      action: "invoke_role",
      roleId: "worker",
      workingDirectory: "AbotMarketSmoke",
      workerCapabilityScope: repeatedScope,
      plan: { summary: "Create the four requested shop artifacts.", items },
      selectedItemIndexes: [0],
    },
  }), {
    availableChildRoleIds: ["worker"],
    availableWorkerCapabilityCatalog: availableCatalog,
    planContext: { mode: "declare", maxItems: 8 },
  });
  expect(parsed).toMatchObject({
    ok: true,
    decision: {
      workerCapabilityScope: normalizedScope,
      plannerPlan: { mode: "declare", plan: { items }, selectedItemIndexes: [0] },
    },
  });
});
