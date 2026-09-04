import { describe, expect, test } from "vitest";

import {
  createPlannerDecisionFormat,
  parsePlannerDecisionOutput,
  type PlannerDecisionPlanContext,
} from "../steps/planner-decision/index.js";

const ITEMS = Object.freeze([
  Object.freeze({
    title: "First outcome",
    objective: "Complete the first outcome.",
  }),
  Object.freeze({
    title: "Second outcome",
    objective: "Complete the second outcome.",
  }),
]);

const CASES: readonly Readonly<{
  planContext: PlannerDecisionPlanContext;
  planFields: Record<string, unknown>;
}>[] = [
  {
    planContext: { mode: "declare", maxItems: 3 },
    planFields: { plan: { summary: "Complete both outcomes.", items: ITEMS } },
  },
  {
    planContext: {
      mode: "extend",
      planId: "plan-call-2",
      summary: "Complete both outcomes.",
      existingItemCount: 1,
      maxItems: 2,
    },
    planFields: { extension: { items: ITEMS } },
  },
];

describe("Planner single-item dispatch", () => {
  test.each(CASES)(
    "rejects multiple selected indexes in $planContext.mode mode",
    ({ planContext, planFields }) => {
      const result = parsePlannerDecisionOutput(
        JSON.stringify({
          decision: {
            action: "invoke_role",
            roleId: "worker",
            workingDirectory: ".",
            ...planFields,
            selectedItemIndexes: [0, 1],
          },
        }),
        { availableChildRoleIds: ["worker"], planContext },
      );

      expect(result).toEqual({
        ok: false,
        stage: "domain_parser",
        issues: [
          {
            code: "planner_plan_item_unavailable",
            path: "decision.selectedItemIndexes",
            message: "Planner decision failed planner_plan_item_unavailable.",
          },
        ],
      });
    },
  );

  test("filters non-Worker roles and rejects Reviewer dispatch", () => {
    const planContext: PlannerDecisionPlanContext = {
      mode: "select",
      planId: "plan-call-2",
      summary: "Audit both completed outcomes.",
      childInvocationAvailable: true,
      pendingItems: ITEMS.map((item, index) => ({
        ...item,
        itemId: `plan-call-2-item-${index + 1}`,
      })),
    };
    const format = createPlannerDecisionFormat({
      availableChildRoleIds: ["worker", "reviewer"],
      planContext,
    });
    const variants = (
      format.schema as {
        properties: { decision: { anyOf: Record<string, unknown>[] } };
      }
    ).properties.decision.anyOf;
    expect(variants[1]).toMatchObject({
      properties: {
        roleId: { enum: ["worker"] },
        planItemIds: { minItems: 1, maxItems: 1 },
      },
    });

    const result = parsePlannerDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_role",
          roleId: "reviewer",
          planItemIds: ["plan-call-2-item-1", "plan-call-2-item-2"],
        },
      }),
      { availableChildRoleIds: ["worker", "reviewer"], planContext },
    );
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "planner_child_role_unavailable",
          path: "decision.roleId",
        }),
      ]),
    });
  });
});
