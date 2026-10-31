import { rootWorkCalls } from "./support/root-invalid-output-fixture.js";
import { withSupervisorPreparation } from "./support/supervisor-model-phases.js";
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
  failureNotice: "The model reached its output-token limit before finishing its decision or response.",
  nextStep: "Review the selected model and reasoning settings before continuing.",
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
      "replaces incomplete %s with one deterministic canonical degraded result",
      async (phase) => {
        const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
          if (input.modelStep === "degraded.finalization")
            throw new Error("known_output_limit_must_not_invoke_authoring");
          if (phase === "response" && input.modelStep === policy.decisionStep)
            return { text: rootRespondOutput(policy.policyId), meta: {} };
          return {
            text: PARTIAL_OUTPUT,
            meta: { providerCompletionReason: "length" },
          };
        }));
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
        expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([
          policy.decisionStep,
          ...(phase === "response" ? [policy.responseStep] : []),
        ]);
        expect(result.output).not.toContain(PARTIAL_OUTPUT);
        expect(invoke.mock.calls.filter(([input]) => input.modelStep === "degraded.finalization")).toEqual([]);
        expect(request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
      },
    );

    test("cancellation wins over incomplete output without publishing framing", async () => {
      const abort = new AbortController();
      const failure = new Error("cancelled_incomplete_root");
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async () => {
        abort.abort(failure);
        return {
          text: PARTIAL_OUTPUT,
          meta: { providerCompletionReason: "length" },
        };
      }));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId, {
        abortSignal: abort.signal,
      });
      const ledger = await createRootInvalidOutputLedger(policy.policyId);
      const initialHead = ledger.current();

      await expect(runRootExecutionKernel({ request, ledger })).rejects.toBe(
        failure,
      );
      expect(ledger.current()).toBe(initialHead);
      expect(rootWorkCalls(invoke)).toHaveLength(1);
      expect(request.onAnswerToken).not.toHaveBeenCalled();
    });

    test.each(["provider", "incomplete", "invalid"] as const)(
      "does not call a presentation model that would return a %s failure",
      async (degradedFailure) => {
        const failure = new Error("degraded_provider_failed");
        const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
          if (input.modelStep !== "degraded.finalization") {
            return {
              text: PARTIAL_OUTPUT,
              meta: { providerCompletionReason: "length" },
            };
          }
          if (degradedFailure === "provider") throw failure;
          return {
            text: "invalid degraded output",
            meta: degradedFailure === "incomplete" ? { providerCompletionReason: "length" } : {},
          };
        }));
        const request = createRootInvalidOutputRequest(invoke, policy.policyId);
        const ledger = await createRootInvalidOutputLedger(policy.policyId);
        const initialHead = ledger.current();
        const result = await runRootExecutionKernel({ request, ledger });

        expect(result.output).toBe(DEGRADED_OUTPUT);
        expect(result.output).not.toContain(PARTIAL_OUTPUT);
        expect(result.disposition).toBe(policy.policyId === "supervisor-worker-v1" ? "blocked" : undefined);
        expect(ledger.current()).not.toBe(initialHead);
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
        expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([policy.decisionStep]);
        expect(invoke.mock.calls.filter(([input]) => input.modelStep === "degraded.finalization")).toEqual([]);
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
        const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async () => {
          throw failure;
        }));
        const request = createRootInvalidOutputRequest(invoke, policy.policyId);
        await expect(runRequestRunner(request)).rejects.toBe(failure);
        expect(rootWorkCalls(invoke)).toHaveLength(1);
        expect(request.onAnswerToken).not.toHaveBeenCalled();
      }
    });
  },
);
