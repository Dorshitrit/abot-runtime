import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH,
  ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
} from "../orchestration/role-calls/index.js";
import {
  buildPlannerDecisionInstructions,
  createPlannerDecisionFormat,
  parsePlannerDecisionOutput,
  PLANNER_DECISION_MODEL_STEP,
  PLANNER_OBJECTIVE_MAX_LENGTH,
  type PlannerDecisionDiagnosticContext,
  type PlannerDecisionPlanContext,
} from "../steps/planner-decision/index.js";

const DECLARE_CONTEXT: PlannerDecisionPlanContext = Object.freeze({
  mode: "declare",
  maxItems: 3,
});

const SELECT_CONTEXT: PlannerDecisionPlanContext = Object.freeze({
  mode: "select",
  planId: "plan-call-2",
  summary: "Inspect, update, and verify the requested target.",
  childInvocationAvailable: true,
  pendingItems: Object.freeze([
    Object.freeze({
      itemId: "plan-call-2-item-2",
      title: "Apply target update",
      objective: "Apply the requested bounded target update.",
    }),
    Object.freeze({
      itemId: "plan-call-2-item-3",
      title: "Review completed work",
      objective: "Audit whether the requested target work is complete.",
    }),
  ]),
});

const DECLARED_MULTI_ITEM_OBJECTIVE = [
  "Complete these bound plan outcomes as one atomic delegated outcome:",
  "1. Inspect target\nInspect the current target state.",
  "2. Apply update\nApply the requested bounded update.",
].join("\n\n");

const SELECTED_MULTI_ITEM_OBJECTIVE = [
  "Complete these bound plan outcomes as one atomic delegated outcome:",
  "1. Apply target update\nApply the requested bounded target update.",
  "2. Review completed work\nAudit whether the requested target work is complete.",
].join("\n\n");

const EXTENDED_MULTI_ITEM_OBJECTIVE = [
  "Complete these bound plan outcomes as one atomic delegated outcome:",
  "1. Resolve completion gap\nResolve only the newly established completion gap.",
  "2. Verify gap closure\nVerify the same bounded gap is closed in the delivered outcome.",
].join("\n\n");

const EXTEND_CONTEXT: PlannerDecisionPlanContext = Object.freeze({
  mode: "extend",
  planId: "plan-call-2",
  summary: "Inspect, update, and verify the requested target.",
  existingItemCount: 2,
  maxItems: 2,
});

const DIAGNOSTIC: PlannerDecisionDiagnosticContext = Object.freeze({
  requestId: "planner-plan-contract-request",
  modelStep: PLANNER_DECISION_MODEL_STEP,
  callId: "call-2",
  parentCallId: "call-1",
  depth: 1,
  invocationAttempt: 1,
});

const AVAILABLE_WORKER_CAPABILITY_CATALOG = Object.freeze([
  Object.freeze({
    groupId: "documents",
    memberCount: 2,
    effects: Object.freeze(["observation", "mutation"] as const),
  }),
]);
const WORKER_CAPABILITY_SCOPE = Object.freeze({
  catalogGroupIds: Object.freeze(["documents"]),
});
const WORKING_DIRECTORY = "projects/planner-plan-contract";

function decisionText(decision: Record<string, unknown>): string {
  return JSON.stringify({ decision });
}

function decisionVariants(
  schema: Record<string, unknown>,
): Record<string, unknown>[] {
  const decision = (
    schema as {
      properties: {
        decision: Record<string, unknown> & {
          anyOf?: Record<string, unknown>[];
        };
      };
    }
  ).properties.decision;
  return decision.anyOf ?? [decision];
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Planner-authored canonical plan decision contract", () => {
  test("publishes a bounded declaration schema and derives the selected child objective", () => {
    const format = createPlannerDecisionFormat({
      availableChildRoleIds: ["worker", "reviewer"],
      availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      planContext: DECLARE_CONTEXT,
    });
    const invokeVariant = decisionVariants(
      format.schema as Record<string, unknown>,
    )[2] as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(invokeVariant).toMatchObject({
      properties: {
        action: { enum: ["invoke_role"] },
        roleId: { enum: ["worker"] },
        workingDirectory: {
          maxLength: ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
        },
        workerCapabilityScope: {
          properties: {
            catalogGroupIds: {
              minItems: 1,
              maxItems: 1,
              items: { enum: ["documents"] },
            },
          },
        },
        plan: {
          properties: {
            summary: { maxLength: PLANNER_OBJECTIVE_MAX_LENGTH },
            items: {
              minItems: 1,
              maxItems: 3,
              items: {
                properties: {
                  title: {
                    maxLength: ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH,
                  },
                  objective: {
                    maxLength: PLANNER_OBJECTIVE_MAX_LENGTH,
                  },
                },
              },
            },
          },
        },
        selectedItemIndexes: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: { type: "integer", minimum: 0, maximum: 2 },
        },
      },
      required: [
        "action",
        "roleId",
        "workingDirectory",
        "workerCapabilityScope",
        "plan",
        "selectedItemIndexes",
      ],
    });
    expect(invokeVariant.required).not.toContain("objective");
    expect(invokeVariant.required).not.toContain("selectedItemIndex");

    const parsed = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
        plan: {
          summary: "  Inspect and update the requested target.  ",
          items: [
            {
              title: "  Inspect target  ",
              objective: "  Inspect the current target state.  ",
            },
            {
              title: "Apply update",
              objective: "Apply the requested bounded update.",
            },
          ],
        },
        selectedItemIndexes: [1, 0],
      }),
      {
        availableChildRoleIds: ["worker", "reviewer"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
        planContext: DECLARE_CONTEXT,
      },
    );

    expect(parsed).toEqual({
      ok: true,
      decision: {
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: DECLARED_MULTI_ITEM_OBJECTIVE,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
        plannerPlan: {
          mode: "declare",
          plan: {
            summary: "Inspect and update the requested target.",
            items: [
              {
                title: "Inspect target",
                objective: "Inspect the current target state.",
              },
              {
                title: "Apply update",
                objective: "Apply the requested bounded update.",
              },
            ],
          },
          selectedItemIndexes: [0, 1],
        },
      },
    });
    if (parsed.ok && parsed.decision.action === "invoke_role") {
      expect(Object.isFrozen(parsed.decision)).toBe(true);
      expect(Object.isFrozen(parsed.decision.plannerPlan)).toBe(true);
    }
  });

  test("selects canonical pending items and derives one ordered child objective", () => {
    const format = createPlannerDecisionFormat({
      availableChildRoleIds: ["worker"],
      availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      planContext: SELECT_CONTEXT,
    });
    const invokeVariant = decisionVariants(
      format.schema as Record<string, unknown>,
    )[1] as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(invokeVariant).toMatchObject({
      properties: {
        planItemIds: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: {
            enum: ["plan-call-2-item-2", "plan-call-2-item-3"],
          },
        },
      },
      required: [
        "action",
        "roleId",
        "workingDirectory",
        "workerCapabilityScope",
        "planItemIds",
      ],
    });
    expect(invokeVariant.required).not.toContain("objective");

    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
          planItemIds: ["plan-call-2-item-3", "plan-call-2-item-2"],
        }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
          planContext: SELECT_CONTEXT,
        },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: SELECTED_MULTI_ITEM_OBJECTIVE,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
        plannerPlan: {
          mode: "select",
          itemIds: ["plan-call-2-item-2", "plan-call-2-item-3"],
        },
      },
    });
  });

  test("keeps select-mode completion runtime-owned and preserves terminal boundaries", () => {
    const variants = decisionVariants(
      createPlannerDecisionFormat({
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
        planContext: SELECT_CONTEXT,
      }).schema as Record<string, unknown>,
    ) as Array<{
      properties: Record<string, unknown>;
      required: string[];
    }>;

    expect(variants[0]).toMatchObject({
      properties: {
        action: { type: "string", enum: ["return_failure"] },
      },
    });
    expect(variants[1]).toMatchObject({
      properties: {
        action: { type: "string", enum: ["invoke_role"] },
      },
    });
    expect(JSON.stringify(variants)).not.toContain("planItems");
    expect(JSON.stringify(variants)).not.toContain("return_result");

    expect(
      parsePlannerDecisionOutput(
        decisionText({
          planItems: [{ id: "plan-call-2-item-2", status: "complete" }],
        }),
        { planContext: SELECT_CONTEXT },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "planner_action_invalid", path: "decision.action" }],
    });

    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "return_result",
          result: "Pending work still exists.",
        }),
        { planContext: SELECT_CONTEXT },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "planner_plan_incomplete", path: "decision.action" }],
    });
    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "return_failure",
          reason: "No completed outcome supports further progress.",
        }),
        { planContext: SELECT_CONTEXT },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "return_failure",
        reason: "No completed outcome supports further progress.",
      },
    });
  });

  test("rejects empty, duplicate, and foreign pending-item selections", () => {
    for (const planItemIds of [
      [],
      ["plan-call-2-item-2", "plan-call-2-item-2"],
      ["plan-call-2-item-999"],
    ]) {
      expect(
        parsePlannerDecisionOutput(
          decisionText({
            action: "invoke_role",
            roleId: "worker",
            workingDirectory: WORKING_DIRECTORY,
            workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
            planItemIds,
          }),
          {
            availableChildRoleIds: ["worker"],
            availableWorkerCapabilityCatalog:
              AVAILABLE_WORKER_CAPABILITY_CATALOG,
            planContext: SELECT_CONTEXT,
          },
        ),
      ).toMatchObject({
        ok: false,
        issues: [
          {
            code: "planner_plan_item_unavailable",
            path: "decision.planItemIds",
          },
        ],
      });
    }
  });

  test("authors only explicit appended work after the canonical plan settles", () => {
    const format = createPlannerDecisionFormat({
      availableChildRoleIds: ["worker"],
      availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      planContext: EXTEND_CONTEXT,
    });
    const invokeVariant = decisionVariants(
      format.schema as Record<string, unknown>,
    )[2] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(invokeVariant).toMatchObject({
      properties: {
        extension: {
          properties: {
            items: { minItems: 1, maxItems: 2 },
          },
        },
        selectedItemIndexes: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: { type: "integer", minimum: 0, maximum: 1 },
        },
      },
      required: [
        "action",
        "roleId",
        "workingDirectory",
        "workerCapabilityScope",
        "extension",
        "selectedItemIndexes",
      ],
    });
    expect(invokeVariant.required).not.toContain("selectedItemIndex");

    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
          extension: {
            items: [
              {
                title: "Resolve completion gap",
                objective: "Resolve only the newly established completion gap.",
              },
              {
                title: "Verify gap closure",
                objective:
                  "Verify the same bounded gap is closed in the delivered outcome.",
              },
            ],
          },
          selectedItemIndexes: [1, 0],
        }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
          planContext: EXTEND_CONTEXT,
        },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: EXTENDED_MULTI_ITEM_OBJECTIVE,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
        plannerPlan: {
          mode: "extend",
          extension: {
            items: [
              {
                title: "Resolve completion gap",
                objective: "Resolve only the newly established completion gap.",
              },
              {
                title: "Verify gap closure",
                objective:
                  "Verify the same bounded gap is closed in the delivered outcome.",
              },
            ],
          },
          selectedItemIndexes: [0, 1],
        },
      },
    });
    expect(
      buildPlannerDecisionInstructions({
        childRolesAvailable: true,
        planContext: EXTEND_CONTEXT,
      }),
    ).toContain("append only that newly established work");
  });

  test("rejects malformed declarations and unavailable selections", () => {
    expect(
      parsePlannerDecisionOutput(
        JSON.stringify({ action: "return_result", result: "Done." }),
      ),
    ).toMatchObject({
      ok: false,
      stage: "json_envelope",
      issues: [{ code: "planner_output_envelope_invalid", path: "decision" }],
    });
    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
          plan: {
            summary: "One bounded plan.",
            items: [],
          },
          selectedItemIndexes: [],
        }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
          planContext: DECLARE_CONTEXT,
        },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "planner_plan_items_invalid",
          path: "decision.plan.items",
        },
        {
          code: "planner_plan_item_unavailable",
          path: "decision.selectedItemIndexes",
        },
      ],
    });
    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
          planItemIds: ["plan-call-2-item-1"],
        }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
          planContext: SELECT_CONTEXT,
        },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "planner_plan_item_unavailable",
          path: "decision.planItemIds",
        },
      ],
    });

    const noPending = createPlannerDecisionFormat({
      availableChildRoleIds: ["worker"],
      availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      planContext: {
        ...SELECT_CONTEXT,
        pendingItems: [],
      },
    });
    expect(
      decisionVariants(noPending.schema as Record<string, unknown>),
    ).toHaveLength(1);
    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
          planItemIds: ["plan-call-2-item-2"],
        }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
          planContext: {
            ...SELECT_CONTEXT,
            childInvocationAvailable: false,
          },
        },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "planner_child_invocation_unavailable",
          path: "decision.action",
        },
      ],
    });
  });

  test("explains the plan boundary and logs only bounded plan metadata", () => {
    const instructions = buildPlannerDecisionInstructions({
      childRolesAvailable: true,
      planContext: DECLARE_CONTEXT,
    });
    expect(instructions).toContain("declare the complete bounded plan");
    expect(instructions).toContain(
      "Select one or more zero-based item indexes in selectedItemIndexes",
    );

    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const secret = "PLAN_CONTENT_MUST_NOT_REACH_DIAGNOSTICS";
    const parsed = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
        plan: {
          summary: secret,
          items: [
            {
              title: secret,
              objective: secret,
            },
          ],
        },
        selectedItemIndexes: [0],
      }),
      {
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
        planContext: DECLARE_CONTEXT,
        diagnostic: DIAGNOSTIC,
      },
    );
    expect(parsed.ok).toBe(true);

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.planner",
          event: "decision.accepted",
          planBindingMode: "declare",
          plannedItemCount: 1,
          selectedPlanItemIndexes: [0],
          selectedPlanItemCount: 1,
          workingDirectoryIncluded: true,
          workingDirectoryLength: WORKING_DIRECTORY.length,
          planSummaryLength: secret.length,
          plannedItemTitleLengths: [secret.length],
          plannedItemObjectiveLengths: [secret.length],
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(WORKING_DIRECTORY);
  });
});
