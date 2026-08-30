import { describe, expect, test } from "vitest";

import { StructuredModelInvalidOutputError } from "../model/invoke-structured-step.js";
import { createRefinementInvalidOutputCause } from "../steps/execution-agent/refinement-reconsideration.js";
import { EXECUTION_AGENT_DECISION_MODEL_STEP } from "../steps/execution-agent/index.js";

describe("Execution Agent refinement invalid output", () => {
  test("creates a canonical invalid-output cause without raw output", () => {
    const error = new StructuredModelInvalidOutputError(
      "invalid_execution_capability_refinement",
      EXECUTION_AGENT_DECISION_MODEL_STEP,
      {
        validationStage: "domain_parser",
        issues: [
          {
            code: "refinement_slot_invalid",
            path: "decision.invocations.invocation_1",
            message: "This message must not enter canonical state.",
          },
        ],
        repairAttempts: 2,
        repeatedInvalidOutput: true,
      },
    );
    const cause = createRefinementInvalidOutputCause(error);
    expect(cause).toEqual({
      kind: "refinement_invalid_output",
      validationStage: "domain_parser",
      issues: [
        {
          code: "refinement_slot_invalid",
          path: "decision.invocations.invocation_1",
        },
      ],
      repairAttempts: 2,
      repeatedInvalidOutput: true,
    });
    expect(JSON.stringify(cause)).not.toContain("This message");
  });
});
