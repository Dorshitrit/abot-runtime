import { describe, expect, test } from "vitest";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import {
  createExecutionAgentDecisionFormat,
  parseExecutionAgentDecisionOutput,
  type ExecutionAgentDecisionContractOptions,
} from "../steps/execution-agent/index.js";

const proposalSources = [
  { sourceResultRef: "proposal-a", itemIds: ["write-a", "shared-check"] },
  { sourceResultRef: "proposal-b", itemIds: ["write-b", "shared-check"] },
] as const;
const adoptionOptions = {
  allowRespond: true,
  workPlan: { sources: proposalSources },
} as const satisfies ExecutionAgentDecisionContractOptions;

function validateDecision(
  decision: unknown,
  options: ExecutionAgentDecisionContractOptions = adoptionOptions,
) {
  return validateJsonSchemaValue(
    createExecutionAgentDecisionFormat(options).schema,
    { decision },
  );
}

function parseDecision(
  decision: unknown,
  options: ExecutionAgentDecisionContractOptions = adoptionOptions,
) {
  return parseExecutionAgentDecisionOutput(
    JSON.stringify({ decision }),
    options,
  );
}

function adoptionDecision(sourceResultRef: string, itemIds: readonly string[]) {
  return {
    action: "respond",
    workPlan: {
      mode: "adopt",
      sourceResultRef,
      itemUpdates: itemIds.map((itemId) => ({ itemId, status: "pending" })),
    },
  };
}

describe("Execution Agent work-plan schema source binding", () => {
  test.each(proposalSources)(
    "accepts only offered identities for $sourceResultRef",
    ({ sourceResultRef, itemIds }) => {
      for (const updates of [[], itemIds, ["shared-check"]]) {
        const decision = adoptionDecision(sourceResultRef, updates);
        expect(validateDecision(decision)).toBeUndefined();
        expect(parseDecision(decision)).toEqual({ ok: true, decision });
      }
    },
  );

  test.each([
    ["proposal-a", ["write-b"]],
    ["proposal-b", ["write-a"]],
    ["proposal-a", ["write-a", "write-b"]],
    ["proposal-b", ["shared-check", "write-a"]],
  ] as const)(
    "rejects items from another proposal for %s: %j",
    (sourceResultRef, itemIds) => {
      const decision = adoptionDecision(sourceResultRef, itemIds);
      expect(parseDecision(decision)).toMatchObject({
        ok: false,
        issues: [{ code: "execution_agent_work_plan_invalid" }],
      });
      expect(validateDecision(decision)).toBeDefined();
    },
  );

  test("retains progress binding to the currently adopted proposal", () => {
    const options = {
      ...adoptionOptions,
      workPlan: {
        ...adoptionOptions.workPlan,
        current: proposalSources[0],
      },
    };
    const progress = {
      action: "respond",
      workPlan: {
        mode: "progress",
        sourceResultRef: "proposal-a",
        itemUpdates: [{ itemId: "write-a", status: "done" }],
      },
    };
    expect(validateDecision(progress, options)).toBeUndefined();
    expect(parseDecision(progress, options)).toEqual({
      ok: true,
      decision: progress,
    });
    for (const alteration of [
      { sourceResultRef: "proposal-b" },
      { itemUpdates: [{ itemId: "write-b", status: "done" }] },
      { itemUpdates: [] },
    ]) {
      const decision = {
        ...progress,
        workPlan: { ...progress.workPlan, ...alteration },
      };
      expect(validateDecision(decision, options)).toBeDefined();
      expect(parseDecision(decision, options)).toMatchObject({ ok: false });
    }
  });

  test("preserves metadata-free actions with multiple proposals", () => {
    const baseline = { allowRespond: true };
    for (const decision of [
      { action: "respond" },
      {
        action: "blocked",
        response: "The requested dependency is unavailable.",
      },
    ]) {
      expect(validateDecision(decision, adoptionOptions)).toEqual(
        validateDecision(decision, baseline),
      );
      expect(validateDecision(decision, adoptionOptions)).toBeUndefined();
      expect(parseDecision(decision, adoptionOptions)).toEqual(
        parseDecision(decision, baseline),
      );
    }
    expect(
      createExecutionAgentDecisionFormat({
        ...baseline,
        workPlan: { sources: [] },
      }),
    ).toEqual(createExecutionAgentDecisionFormat(baseline));
  });
});
