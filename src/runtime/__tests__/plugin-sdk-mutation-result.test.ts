import { describe, expect, test } from "vitest";
import {
  mutationSuccessResult,
  successResult,
  PLUGIN_RESULT_SERIALIZED_MAX_BYTES,
  type ToolImplementationOutput,
  type ToolResultBudget,
} from "../../plugin-sdk/index.js";
import { projectToolExecutionResult } from "../../capabilities/tool-result-normalization.js";
import { observeExternalResult } from "../adapters/registered-tool-worker-capabilities/result-observer.js";

function observePluginResult(
  result: ToolImplementationOutput,
  effect: "mutating" | "mixed" | "read_only",
) {
  return observeExternalResult(
    {
      status: "executed",
      effect,
      result: projectToolExecutionResult("example_publish", result),
      completionActions: result.actions ?? [],
    },
    effect,
    true,
  ).result;
}

describe("SDK mutation success results", () => {
  test.each(["mutating", "mixed"] as const)(
    "a confirmed receipt reaches canonical %s success with its data intact",
    (effect) => {
      const data = Object.freeze({
        entry: Object.freeze({ id: "entry-123", version: 2 }),
        receipt: Object.freeze({ requestId: "api-request", persisted: true }),
      });
      const input = Object.freeze({
        output: "The article was published.",
        data,
        actions: [{ type: "publish", target: "entry-123" }],
      });
      const result = mutationSuccessResult(input);
      expect(result).toMatchObject({
        ok: true,
        output: input.output,
        producedNewInformation: true,
        actions: input.actions,
        data: { ...data, mutationEvidence: true },
      });
      expect(result.data).toEqual({ ...data, mutationEvidence: true });
      expect(data).not.toHaveProperty("mutationEvidence");
      expect(result).not.toHaveProperty("progress");
      expect(observePluginResult(result, effect)).toMatchObject({
        outcome: "succeeded",
        observedEffect: "mutation",
        exactResult: { result: { ok: true, data: result.data } },
      });
    },
  );

  test("ordinary success remains an observation without inventing mutation evidence", () => {
    const result = successResult({
      output: "Current article.",
      data: { id: "entry-123" },
    });
    expect(result.data).toEqual({ id: "entry-123" });
    expect(observePluginResult(result, "read_only")).toMatchObject({
      outcome: "succeeded",
      observedEffect: "observation",
    });
    expect(observePluginResult(result, "mutating")).toMatchObject({
      outcome: "failed",
      observedEffect: "none",
    });
  });

  test("the host budget sees the added evidence before accepting the result", () => {
    let assessed: ToolImplementationOutput | undefined;
    const budget: ToolResultBudget = {
      assess(result) {
        assessed = result;
        const bytes = Buffer.byteLength(JSON.stringify(result));
        return {
          fits: false,
          serializedBytes: bytes,
          envelopeBytes: bytes,
          maxBytes: bytes - 1,
        };
      },
    };
    const result = mutationSuccessResult(
      { output: "Published.", data: { id: "entry-123" } },
      budget,
    );
    expect(assessed?.data).toEqual({ id: "entry-123", mutationEvidence: true });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "plugin_result_too_large",
    });
    expect(result.data?.mutationEvidence).not.toBe(true);
    expect(observePluginResult(result, "mutating")).toMatchObject({
      outcome: "failed",
      observedEffect: "none",
    });
  });

  test("oversized or cyclic receipts do not report mutation success", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cases = [
      {
        data: { payload: "x".repeat(PLUGIN_RESULT_SERIALIZED_MAX_BYTES) },
        code: "plugin_result_too_large",
      },
      { data: cyclic, code: "plugin_result_not_json_safe" },
    ];
    for (const { data, code } of cases) {
      const result = mutationSuccessResult({ output: "Published.", data });
      expect(result).toMatchObject({ ok: false, errorCode: code });
      expect(result.data?.mutationEvidence).not.toBe(true);
    }
  });
});
