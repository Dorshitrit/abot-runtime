import { describe, expect, test } from "vitest";
import { parsePlannerGraphOutput } from "../steps/planner-graph/parser.js";
import {
  EXECUTION_AGENT_PLANNER_GRAPH_LIMITS,
  type PlannerGraphLimits,
} from "../steps/planner-graph/contracts.js";

function node(localId: string, dependsOn: string[] = []) {
  return {
    localId,
    title: localId,
    objective: `Establish ${localId}.`,
    dependsOn,
    acceptanceCriteria: [
      {
        localId: `${localId}_verified`,
        description: `Verify ${localId}.`,
        verification: "semantic",
      },
    ],
  };
}

function parse(
  nodes: readonly unknown[],
  limits: PlannerGraphLimits = EXECUTION_AGENT_PLANNER_GRAPH_LIMITS,
) {
  return parsePlannerGraphOutput(
    JSON.stringify({
      decision: { summary: "Build and verify one application.", nodes },
    }),
    limits,
  );
}

describe("advisory planning for complex integrated development", () => {
  test("accepts dependent implementation and verification with one final deliverable", () => {
    const nodes = [node("implement"), node("verify", ["implement"])];
    expect(parse(nodes)).toMatchObject({
      ok: true,
      decision: { outcome: "proposal", proposal: { nodes } },
    });
  });

  test("accepts parallel components converging into one integrated result", () => {
    const nodes = [node("data"), node("ui"), node("integrate", ["data", "ui"])];
    expect(parse(nodes)).toMatchObject({
      ok: true,
      decision: { outcome: "proposal" },
    });
  });

  test("preserves independent multiple-deliverable planning", () => {
    expect(parse([node("alpha"), node("beta")])).toMatchObject({ ok: true });
  });

  test.each([
    ["empty", []],
    ["single", [node("only")]],
    ["duplicate", [node("same"), node("same")]],
    ["unknown dependency", [node("first"), node("second", ["absent"])]],
    ["self dependency", [node("first", ["first"]), node("second")]],
    ["cycle", [node("first", ["second"]), node("second", ["first"])]],
    [
      "missing criteria",
      [node("first"), { ...node("second"), acceptanceCriteria: [] }],
    ],
  ] as const)("still rejects %s", (_label, nodes) => {
    expect(parse([...nodes])).toMatchObject({ ok: false });
  });

  test("retains configured graph and criterion bounds", () => {
    expect(
      parse([node("a"), node("b"), node("c")], {
        maxPlanNodes: 2,
        maxCriteriaPerNode: 1,
      }),
    ).toMatchObject({ ok: false });
    const extraCriteria = {
      ...node("b"),
      acceptanceCriteria: [
        ...node("b").acceptanceCriteria,
        { ...node("b").acceptanceCriteria[0]!, localId: "second_check" },
      ],
    };
    expect(
      parse([node("a"), extraCriteria], {
        maxPlanNodes: 2,
        maxCriteriaPerNode: 1,
      }),
    ).toMatchObject({ ok: false });
  });

  test("retains honest decline for work that needs no decomposition", () => {
    expect(
      parsePlannerGraphOutput(
        JSON.stringify({
          decision: {
            action: "decline",
            reason: "A direct answer is sufficient.",
          },
        }),
        EXECUTION_AGENT_PLANNER_GRAPH_LIMITS,
      ),
    ).toEqual({
      ok: true,
      decision: {
        outcome: "decline",
        reason: "A direct answer is sufficient.",
      },
    });
  });
});
