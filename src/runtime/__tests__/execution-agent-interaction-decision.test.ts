import { describe, expect, test } from "vitest";
import {
  createExecutionAgentDecisionFormat,
  parseExecutionAgentDecisionOutput,
} from "../steps/execution-agent/index.js";
import { USER_INTERACTION_TEXT_MAX_LENGTH } from "../user-interactions/contracts.js";

const options = {
  allowPlanner: true,
  allowMemoryRecall: true,
  capabilityCatalogGroupIds: ["files"],
  allowUserInteraction: true,
};
const message = { kind: "message", text: "מצאתי את נקודת החיבור; אבדוק את החוזה." };
const planner = { action: "invoke_planner", objective: "Plan the requested work." };
const envelope = (decision: unknown) => JSON.stringify({ decision });

type Variant = {
  properties: Record<string, unknown> & { action: { enum: readonly string[] } };
  required: readonly string[];
};

function decisionVariants(schema: Record<string, unknown>): readonly Variant[] {
  const properties = schema.properties as { decision: { anyOf: readonly Variant[] } };
  return properties.decision.anyOf;
}

describe("EA optional user interaction decision", () => {
  test("offers a nullable message only on nonterminal actions without multiplying variants", () => {
    const disabled = createExecutionAgentDecisionFormat({ ...options, allowUserInteraction: false });
    const enabled = createExecutionAgentDecisionFormat(options);
    const disabledVariants = decisionVariants(disabled.schema);
    const enabledVariants = decisionVariants(enabled.schema);
    expect(enabledVariants).toHaveLength(disabledVariants.length);
    enabledVariants.forEach((variant) => {
      const action = variant.properties.action.enum[0];
      if (action === "respond" || action === "blocked") {
        expect(variant.properties).not.toHaveProperty("interaction");
        return;
      }
      expect(variant.required).toContain("interaction");
      expect(variant.properties.interaction).toEqual({
        anyOf: [
          { type: "null" },
          {
            type: "object", additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["message"] },
              text: { type: "string", minLength: 1, maxLength: USER_INTERACTION_TEXT_MAX_LENGTH },
            },
            required: ["kind", "text"],
          },
        ],
      });
    });
    expect(JSON.stringify(disabled.schema)).not.toContain('"interaction"');
  });

  test.each([
    planner,
    { action: "open_capability_scope", catalogGroupIds: ["files"] },
    { action: "recall_memory", query: "Find prior project conventions." },
  ])("preserves a valid message with $action", (action) => {
    expect(parseExecutionAgentDecisionOutput(envelope({ ...action, interaction: message }), options))
      .toEqual({ ok: true, decision: { ...action, interaction: message } });
  });

  test.each([undefined, null])("allows no update (%s)", (interaction) => {
    expect(parseExecutionAgentDecisionOutput(envelope({ ...planner, interaction }), options))
      .toEqual({ ok: true, decision: planner });
  });

  test("keeps requests without the service on the original contract", () => {
    expect(parseExecutionAgentDecisionOutput(envelope(planner), { allowPlanner: true }))
      .toEqual({ ok: true, decision: planner });
    expect(parseExecutionAgentDecisionOutput(envelope({ ...planner, interaction: message }), {
      allowPlanner: true,
    })).toMatchObject({ ok: false, issues: [{ code: "execution_agent_interaction_invalid" }] });
  });

  test.each([
    { kind: "question", text: "Choose a path." },
    { kind: "message", text: "" },
    { kind: "message", text: "  \n " },
    { kind: "message", text: "x".repeat(USER_INTERACTION_TEXT_MAX_LENGTH + 1) },
    { kind: "message", text: "Progress.", requestId: "model-invented" },
    { kind: "message" },
    "Progress.",
    [],
  ])("rejects malformed or unsupported interaction %#", (interaction) => {
    expect(parseExecutionAgentDecisionOutput(envelope({ ...planner, interaction }), options))
      .toMatchObject({ ok: false, issues: [{ code: "execution_agent_interaction_invalid" }] });
  });

  test.each([
    { action: "respond" },
    { action: "blocked", response: "Need a target." },
    { action: "reconsider_capability_selection" },
  ])("does not let $action carry an update", (action) => {
    for (const interaction of [message, null])
      expect(parseExecutionAgentDecisionOutput(envelope({ ...action, interaction }), options))
        .toMatchObject({ ok: false, issues: [{ code: "execution_agent_interaction_invalid" }] });
  });

  test("composes one interaction with the existing work plan report", () => {
    const workPlan = {
      mode: "adopt", sourceResultRef: "result-1",
      itemUpdates: [{ itemId: "item-1", status: "in_progress" }],
    };
    const decision = { ...planner, interaction: message, workPlan };
    const contract = {
      ...options,
      workPlan: { sources: [{ sourceResultRef: "result-1", itemIds: ["item-1"] }] },
    };
    expect(parseExecutionAgentDecisionOutput(envelope(decision), contract))
      .toEqual({ ok: true, decision });
    const variants = decisionVariants(createExecutionAgentDecisionFormat(contract).schema);
    expect(variants.filter((variant) => variant.properties.action.enum[0] === "invoke_planner"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ required: expect.arrayContaining(["interaction", "workPlan"]) }),
      ]));
  });
});
