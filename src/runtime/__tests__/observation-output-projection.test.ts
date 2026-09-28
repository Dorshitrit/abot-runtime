import { describe, expect, test } from "vitest";

import type { ToolExecutionResult } from "../../capabilities/tool-types.js";
import {
  ROLE_CALL_RESULT_MAX_LENGTH,
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
} from "../orchestration/role-calls/index.js";
import { projectObservationOutput } from "../adapters/registered-tool-worker-capabilities/result-evidence.js";
import { observeExternalResult } from "../adapters/registered-tool-worker-capabilities/result-observer.js";

const WINDOW_HEADER = [
  "Coverage: characters 0-10000 of 22589 (partial)",
  "Returned characters: 10000; omitted before window: 0; remaining after window: 12589.",
  "Next start_char: 10000",
].join("\n");

function observation(output: string): ToolExecutionResult {
  return {
    ok: true,
    tool: "generic_reader",
    output,
    producedNewInformation: true,
    data: { source: "canonical-only", opaqueFact: 17 },
  };
}

describe("observation output summary projection", () => {
  test.each(["read_only", "mixed"] as const)(
    "keeps bounded coverage visible without changing %s evidence",
    (effect) => {
      const execution = observation(`${WINDOW_HEADER}\n${"x".repeat(10_000)}`);
      const before = JSON.stringify(execution);
      const observed = observeExternalResult(
        {
          status: "executed",
          effect,
          result: execution,
          completionActions: [],
        },
        effect,
        false,
      );
      expect(observed.result).toMatchObject({
        outcome: "succeeded",
        observedEffect: "observation",
        referenceData: execution.output,
        exactResult: {
          kind: "registered_tool_execution_result_v1",
          result: execution,
        },
      });
      expect(observed.result.summary).toContain(WINDOW_HEADER);
      expect(
        observed.result.summary.endsWith(execution.output.slice(0, 512)),
      ).toBe(true);
      expect(observed.result.summary).toContain(
        `${execution.output.length - 512} omitted`,
      );
      expect(observed.result.summary.length).toBeLessThanOrEqual(
        ROLE_CALL_RESULT_MAX_LENGTH,
      );
      expect(JSON.stringify(execution)).toBe(before);
    },
  );

  test("preserves short summaries and existing direct-root projection", () => {
    const shortOutput = "An unrelated observation.";
    expect(projectObservationOutput(shortOutput)).toEqual({
      summary: shortOutput,
    });
    expect(projectObservationOutput(shortOutput, true)).toEqual({
      summary: shortOutput,
    });
    const longOutput = "q".repeat(ROLE_CALL_RESULT_MAX_LENGTH + 1);
    expect(projectObservationOutput(longOutput, true)).toEqual({
      summary: "The capability result is available in the canonical direct execution result.",
    });
    const canonicalOnlyOutput =
      "q".repeat(ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH + 1);
    const canonicalOnly = projectObservationOutput(canonicalOnlyOutput);
    expect(canonicalOnly).not.toHaveProperty("referenceData");
    expect(canonicalOnly.summary.endsWith("q".repeat(512))).toBe(true);
    expect(canonicalOnly.summary).toContain(
      `${canonicalOnlyOutput.length - 512} omitted`,
    );
  });

  test("previews an opaque prefix without inferring coverage from data keys", () => {
    const execution = observation("opaque prefix\n" + "q".repeat(9_000));
    const input = {
      status: "executed" as const,
      effect: "read_only" as const,
      result: execution,
      completionActions: [],
    };
    const baseline = observeExternalResult(input, "read_only", false);
    const withUnrelatedData = observeExternalResult(
      {
        ...input,
        result: {
          ...execution,
          data: { startChar: 0, endChar: 10_000, totalCharacters: 22_589 },
        },
      },
      "read_only",
      false,
    );
    expect(withUnrelatedData.result.summary).toBe(baseline.result.summary);
    expect(withUnrelatedData.result.referenceData).toBe(execution.output);
    expect(
      baseline.result.summary.endsWith(execution.output.slice(0, 512)),
    ).toBe(true);
  });

  test("does not split a Unicode character at the preview boundary", () => {
    const output = "a".repeat(511) + "🧪" + "b".repeat(9_000);
    const projected = projectObservationOutput(output);
    expect(projected.summary.endsWith("a".repeat(511))).toBe(true);
    expect(projected.summary).toContain(`${output.length - 511} omitted`);
    expect(projected.referenceData).toBe(output);
  });
});
