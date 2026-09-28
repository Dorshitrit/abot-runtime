import { describe, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import { invokeStructuredModelStep } from "../model/invoke-structured-step.js";
import { invokeRepairableRawModelStep } from "../model/invoke-raw-step.js";
import { createInvalidOutputRequest } from "./support/invalid-output-request.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

describe("abort precedence at invalid or incomplete output", () => {
  test.each([
    ["structured", "invalid"],
    ["raw", "invalid"],
    ["structured", "incomplete"],
    ["raw", "incomplete"],
  ] as const)(
    "preserves the abort during %s %s output",
    async (contract, outputKind) => {
      const abortController = new AbortController();
      const abortReason = new Error("request_aborted_after_model_output");
      const expectedInvocations = outputKind === "incomplete" ? 1 : 3;
      let invocations = 0;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
        invocations += 1;
        if (invocations === expectedInvocations)
          abortController.abort(abortReason);
        return {
          text: "",
          meta:
            outputKind === "incomplete"
              ? { providerCompletionReason: "length" }
              : {},
        };
      });
      const request = deriveTestRequestExecutionScope(
        createInvalidOutputRequest(invoke),
        {
          abortSignal: abortController.signal,
        },
      );
      const output =
        contract === "structured"
          ? invokeStructuredModelStep({
              request,
              modelStep: "worker.decision",
              messages: [
                { role: "user", content: "Return a bounded decision." },
              ],
              format: {
                type: "json_schema",
                name: "decision",
                strict: true,
                schema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
              timeoutReason: "worker_decision_timeout",
              invalidOutputReason: "invalid_worker_decision",
              parse: () => ({
                ok: false,
                stage: "domain_parser",
                issues: [
                  {
                    code: "empty_decision",
                    path: "decision",
                    message: "Return a decision.",
                  },
                ],
              }),
            })
          : invokeRepairableRawModelStep({
              request,
              modelStep: "worker.result",
              messages: [{ role: "user", content: "Return a bounded result." }],
              timeoutReason: "worker_result_timeout",
              maxRepairAttempts: 2,
              validate: () => ({
                ok: false,
                stage: "raw_result",
                reason: "invalid_worker_result",
                issues: [
                  {
                    code: "worker_result_empty",
                    path: "result",
                    message: "Return a result.",
                  },
                ],
              }),
              buildRepairHint: () => "Return a nonempty result.",
            });
      await expect(output).rejects.toBe(abortReason);
      expect(invoke).toHaveBeenCalledTimes(expectedInvocations);
    },
  );
});
