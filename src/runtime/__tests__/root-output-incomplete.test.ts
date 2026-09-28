import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelOutputIncompleteError } from "../model/provider-completion.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
  ROOT_OUTPUT_POLICIES,
  rootRespondOutput,
} from "./support/root-invalid-output-fixture.js";

const PARTIAL_OUTPUT = "UNTRUSTED_PARTIAL_ROOT_OUTPUT";
const PHRASING = {
  failureNotice: "The final model output stopped before completion.",
  nextStep: "Continue from the established state in a follow-up request.",
};
const DEGRADED_OUTPUT = `${PHRASING.failureNotice}\n\n${PHRASING.nextStep}`;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe.each(ROOT_OUTPUT_POLICIES)(
  "$policyId root provider output limit",
  (policy) => {
    test.each(["decision", "response"] as const)(
      "replaces incomplete %s with one model-authored canonical degraded result",
      async (phase) => {
        const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
          if (input.modelStep === "degraded.finalization") {
            expect(JSON.stringify(input.messages)).toContain(
              "output_incomplete",
            );
            expect(JSON.stringify(input.messages)).not.toContain(
              PARTIAL_OUTPUT,
            );
            return { text: JSON.stringify(PHRASING), meta: {} };
          }
          if (phase === "response" && input.modelStep === policy.decisionStep)
            return { text: rootRespondOutput(policy.policyId), meta: {} };
          return {
            text: PARTIAL_OUTPUT,
            meta: { providerCompletionReason: "length" },
          };
        });
        const request = createRootInvalidOutputRequest(invoke, policy.policyId);
        const ledger = await createRootInvalidOutputLedger(policy.policyId);
        const result = await runRootExecutionKernel({ request, ledger });

        expect(result.output).toBe(DEGRADED_OUTPUT);
        expect(result.finalObservation).toBeUndefined();
        expect(result.memoryCandidates).toBeUndefined();
        expect(ledger.current().state).toMatchObject({
          phase: "completed",
          activeCallId: null,
          rootResponse: DEGRADED_OUTPUT,
          results: [],
          capabilityExecutions: [],
        });
        expect(ledger.current().state.calls).toEqual([
          expect.objectContaining({ status: "completed", activationCount: 1 }),
        ]);
        expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
          policy.decisionStep,
          ...(phase === "response" ? [policy.responseStep] : []),
          "degraded.finalization",
        ]);
        expect(request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
      },
    );

    test("cancellation wins over incomplete output without publishing framing", async () => {
      const abort = new AbortController();
      const failure = new Error("cancelled_incomplete_root");
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
        abort.abort(failure);
        return {
          text: PARTIAL_OUTPUT,
          meta: { providerCompletionReason: "length" },
        };
      });
      const request = createRootInvalidOutputRequest(invoke, policy.policyId, {
        abortSignal: abort.signal,
      });
      const ledger = await createRootInvalidOutputLedger(policy.policyId);
      const initialHead = ledger.current();

      await expect(runRootExecutionKernel({ request, ledger })).rejects.toBe(
        failure,
      );
      expect(ledger.current()).toBe(initialHead);
      expect(invoke).toHaveBeenCalledOnce();
      expect(request.onAnswerToken).not.toHaveBeenCalled();
    });

    test.each(["provider", "incomplete", "invalid"] as const)(
      "propagates a %s failure of degraded finalization without a substitute answer",
      async (degradedFailure) => {
        const failure = new Error("degraded_provider_failed");
        const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
          if (input.modelStep !== "degraded.finalization") {
            return {
              text: PARTIAL_OUTPUT,
              meta: { providerCompletionReason: "length" },
            };
          }
          if (degradedFailure === "provider") throw failure;
          return {
            text: "invalid degraded output",
            meta:
              degradedFailure === "incomplete"
                ? { providerCompletionReason: "length" }
                : {},
          };
        });
        const request = createRootInvalidOutputRequest(invoke, policy.policyId);
        const ledger = await createRootInvalidOutputLedger(policy.policyId);
        const initialHead = ledger.current();
        const running = runRootExecutionKernel({ request, ledger });
        if (degradedFailure === "provider") {
          await expect(running).rejects.toBe(failure);
        } else {
          await expect(running).rejects.toMatchObject({
            modelStep: "degraded.finalization",
            message:
              degradedFailure === "incomplete"
                ? "output_incomplete"
                : "invalid_degraded_finalization_output",
          });
        }
        expect(ledger.current()).toBe(initialHead);
        expect(ledger.current().state.rootResponse).toBeNull();
        expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
          policy.decisionStep,
          ...Array<string>(degradedFailure === "invalid" ? 3 : 1).fill(
            "degraded.finalization",
          ),
        ]);
        expect(request.onAnswerToken).not.toHaveBeenCalled();
      },
    );

    test("does not consume incomplete errors from another step or from text alone", async () => {
      const foreignRootStep =
        policy.policyId === "supervisor-worker-v1"
          ? "execution.decision"
          : "supervisor.decision";
      const diagnostics = {
        outputLength: 0,
        providerCompletionReason: "length",
      };
      const failures = [
        new Error("output_incomplete"),
        new ModelOutputIncompleteError(diagnostics),
        new ModelOutputIncompleteError(diagnostics, "worker.result"),
        new ModelOutputIncompleteError(diagnostics, "context.compact"),
        new ModelOutputIncompleteError(diagnostics, foreignRootStep),
      ];
      for (const failure of failures) {
        const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
          throw failure;
        });
        const request = createRootInvalidOutputRequest(invoke, policy.policyId);
        await expect(runRequestRunner(request)).rejects.toBe(failure);
        expect(invoke).toHaveBeenCalledOnce();
        expect(request.onAnswerToken).not.toHaveBeenCalled();
      }
    });
  },
);
