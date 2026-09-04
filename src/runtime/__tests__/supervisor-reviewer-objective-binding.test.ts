import { describe, expect, test } from "vitest";

import {
  createSupervisorDecisionFormat,
  parseSupervisorDecisionOutput,
} from "../steps/supervisor-decision/index.js";

function reviewerVariant(
  schema: Record<string, unknown>,
): Readonly<{
  properties: Record<string, unknown>;
  required: readonly string[];
}> {
  const decision = (
    schema.properties as Record<string, Record<string, unknown>>
  ).decision;
  const variants = (decision.anyOf ?? [decision]) as Record<string, unknown>[];
  const reviewer = variants.find((variant) =>
    (
      variant.properties as
        | Record<string, Readonly<{ enum?: readonly string[] }>>
        | undefined
    )?.roleId?.enum?.includes("reviewer"),
  );
  if (!reviewer) throw new Error("reviewer decision variant missing");
  return reviewer as unknown as Readonly<{
    properties: Record<string, unknown>;
    required: readonly string[];
  }>;
}

describe("Supervisor Reviewer objective binding", () => {
  test("keeps the Reviewer route free of a model-authored objective", () => {
    const format = createSupervisorDecisionFormat({
      allowedRoleIds: ["reviewer"],
    });
    const variant = reviewerVariant(format.schema);

    expect(variant.required).toEqual(["action", "roleId"]);
    expect(variant.properties).not.toHaveProperty("objective");
  });

  test("accepts the Reviewer route without manufacturing model prose", () => {
    expect(
      parseSupervisorDecisionOutput(
        JSON.stringify({
          decision: { action: "invoke_role", roleId: "reviewer" },
        }),
        { allowedRoleIds: ["reviewer"] },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_role",
        roleId: "reviewer",
      },
    });
  });

  test("rejects a Reviewer route that tries to author another objective", () => {
    expect(
      parseSupervisorDecisionOutput(
        JSON.stringify({
          decision: {
            action: "invoke_role",
            roleId: "reviewer",
            objective: "Add a new proof obligation.",
          },
        }),
        { allowedRoleIds: ["reviewer"] },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "supervisor_decision_shape_invalid" }),
      ]),
    });
  });
});
