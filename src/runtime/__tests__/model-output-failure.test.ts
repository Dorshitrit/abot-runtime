import { describe, expect, test } from "vitest";
import type { ModelStep } from "../../shared/model-steps.js";
import { resolveModelOutputFailure } from "../model/invalid-output-failure.js";
import { RawModelValidationError } from "../model/invoke-raw-step.js";
import { StructuredModelInvalidOutputError } from "../model/invoke-structured-step.js";
import { ModelOutputIncompleteError } from "../model/provider-completion.js";

describe("exhausted model output failure classification", () => {
  test.each<[string, ModelStep]>([
    ["invalid_supervisor_decision", "supervisor.decision"],
    ["invalid_execution_agent_decision", "execution.decision"],
    ["invalid_planner_decision", "planner.decision"],
    ["invalid_worker_decision", "worker.decision"],
    ["invalid_worker_decision", "capability.controls"],
    ["invalid_reviewer_decision", "reviewer.decision"],
    ["invalid_execution_agent_authored_response", "execution.response"],
  ])(
    "recognizes %s on %s with bounded validation metadata",
    (code, modelStep) => {
      expect(
        resolveModelOutputFailure(structuredError(code, modelStep)),
      ).toEqual({
        code,
        modelStep,
        validationStage: "domain_parser",
        issues: [{ code: "decision_shape_invalid", path: "decision" }],
        repairAttempts: 2,
      });
    },
  );

  test.each<[string, ModelStep, string]>([
    ["invalid_worker_result", "worker.result", "raw_result"],
    ["invalid_supervisor_response", "supervisor.response", "raw_response"],
    [
      "invalid_execution_agent_response",
      "execution.response",
      "response_contract",
    ],
  ])(
    "recognizes raw %s only at its validation boundary",
    (code, modelStep, stage) => {
      const error = new RawModelValidationError({
        reason: code,
        stage,
        issues: [
          { code: "empty_output", path: "output", message: "unprojected" },
        ],
      });
      expect(resolveModelOutputFailure(error)).toEqual({
        code,
        modelStep,
        validationStage: stage,
        issues: [{ code: "empty_output", path: "output" }],
      });
      expect(
        resolveModelOutputFailure(
          new RawModelValidationError({
            reason: code,
            stage: "different_contract",
            issues: error.issues,
          }),
        ),
      ).toBeUndefined();
    },
  );

  test.each([
    "context_compaction_output_not_json",
    "context_compaction_output_shape_invalid",
    "context_compaction_continuation_invalid",
    "context_compaction_continuation_length_invalid",
    "context_compaction_sources_invalid",
    "context_compaction_source_invalid",
    "context_compaction_digest_length_invalid",
    "context_compaction_digest_not_semantic",
  ])("recognizes model-owned compaction issue %s", (issueCode) => {
    expect(
      resolveModelOutputFailure(
        structuredError(
          "invalid_context_compaction_output",
          "context.compact",
          [issueCode],
        ),
      ),
    ).toMatchObject({
      code: "invalid_context_compaction_output",
      modelStep: "context.compact",
    });
  });

  test.each([
    "session_memory_output_not_json",
    "session_memory_output_shape_invalid",
    "session_memory_summary_invalid",
  ])("recognizes model-owned session memory issue %s", (issueCode) => {
    expect(
      resolveModelOutputFailure(
        structuredError(
          "invalid_session_memory_compaction_output",
          "context.compact",
          [issueCode],
        ),
      ),
    ).toMatchObject({
      code: "invalid_session_memory_compaction_output",
      modelStep: "context.compact",
    });
  });

  test.each([
    { issueCodes: ["context_compaction_digest_allowance_invalid"] },
    { issueCodes: ["future_internal_compaction_issue"] },
    {
      issueCodes: [
        "context_compaction_output_not_json",
        "context_compaction_digest_allowance_invalid",
      ],
    },
    { issueCodes: [] },
  ])(
    "keeps internal or unknown compaction issues fatal: $issueCodes",
    ({ issueCodes }) => {
      expect(
        resolveModelOutputFailure(
          structuredError(
            "invalid_context_compaction_output",
            "context.compact",
            issueCodes,
          ),
        ),
      ).toBeUndefined();
    },
  );

  test("does not classify runtime, provider, budget, abort, or unrelated output failures", () => {
    const errors: unknown[] = [
      undefined,
      "invalid_worker_decision",
      {
        name: "StructuredModelInvalidOutputError",
        message: "invalid_worker_decision",
      },
      ...[
        "invalid_worker_decision",
        "invalid_final_output",
        "invalid_current_state",
        "invalid_command",
        "request_context_required_content_exceeds_budget",
        "context_compaction_input_binding_invalid",
        "context_compaction_source_refs_invalid",
        "context_compaction_timeout",
        "session_memory_compaction_timeout",
        "model_stream_error",
        "request_aborted",
        "structured_model_repair_state_invalid",
      ].map((message) => new Error(message)),
      new ModelOutputIncompleteError({
        outputLength: 0,
        providerCompletionReason: "length",
      }),
      structuredError("invalid_worker_decision", "supervisor.decision"),
      structuredError("invalid_auditor_decision", "auditor.decision"),
      structuredError(
        "invalid_execution_capability_refinement",
        "capability.controls",
      ),
      new RawModelValidationError({
        reason: "invalid_tool_payload",
        stage: "raw_result",
        issues: [],
      }),
    ];
    for (const error of errors) {
      expect(resolveModelOutputFailure(error)).toBeUndefined();
    }
  });

  test("projects only bounded immutable issue identity without rejected content", () => {
    const error = new StructuredModelInvalidOutputError(
      "invalid_worker_decision",
      "worker.decision",
      {
        validationStage: "s".repeat(200),
        issues: Array.from({ length: 20 }, () => ({
          code: "c".repeat(200),
          path: "p".repeat(300),
          message: "rejected model content must not be projected",
        })),
        repairAttempts: 2,
        repeatedInvalidOutput: true,
      },
    );
    const failure = resolveModelOutputFailure(error)!;
    expect(failure.validationStage).toHaveLength(120);
    expect(failure.issues).toHaveLength(8);
    expect(failure.issues[0]).toEqual({
      code: "c".repeat(120),
      path: "p".repeat(160),
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.issues)).toBe(true);
    expect(Object.isFrozen(failure.issues[0])).toBe(true);
  });
});

function structuredError(
  code: string,
  modelStep: ModelStep,
  issueCodes: readonly string[] = ["decision_shape_invalid"],
): StructuredModelInvalidOutputError {
  return new StructuredModelInvalidOutputError(code, modelStep, {
    validationStage: "domain_parser",
    issues: issueCodes.map((issueCode) => ({
      code: issueCode,
      path: "decision",
      message: "unprojected",
    })),
    repairAttempts: 2,
    repeatedInvalidOutput: true,
  });
}
