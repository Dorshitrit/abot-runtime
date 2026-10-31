import { rootWorkCalls } from "./support/root-invalid-output-fixture.js";
import { withSupervisorPreparation, supervisorFormatName } from "./support/supervisor-model-phases.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe.each(ROOT_OUTPUT_POLICIES)(
  "$policyId root invalid-output boundary",
  (policy) => {
    test("exhausts existing structured repairs and commits one degraded answer", async () => {
      const phrasing = {
        failureNotice: "The model could not produce a valid decision.",
        nextStep: "Continue from the established state in a follow-up request.",
      };
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => ({
        text:
          input.modelStep === "degraded.finalization"
            ? JSON.stringify(phrasing)
            : "malformed decision",
        meta: {},
      })));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId);
      const ledger = await createRootInvalidOutputLedger(policy.policyId);
      const result = await runRootExecutionKernel({ request, ledger });
      const expected = result.output;
      expect(expected).toContain("model returned an invalid decision or response");
      expect(expected).not.toContain(phrasing.nextStep);

      expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([
        policy.decisionStep,
        policy.decisionStep,
        policy.decisionStep,
      ]);
      expect(result.output).toBe(expected);
      expect(result.finalObservation).toBeUndefined();
      expect(result.memoryCandidates).toBeUndefined();
      expect(ledger.current().state).toMatchObject({
        phase: "completed",
        activeCallId: null,
        rootResponse: expected,
        results: [],
        capabilityExecutions: [],
      });
      expect(ledger.current().state.calls).toEqual([
        expect.objectContaining({ status: "completed", activationCount: 1 }),
      ]);
      expect(request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
    });

    test("preserves response repairs and presents the known failure without another model attempt", async () => {
      const phrasing = {
        failureNotice: "I could not produce a reliable final answer.",
        nextStep: "Continue using the established state.",
      };
      let degradedAttempts = 0;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
        if (input.modelStep === policy.decisionStep)
          return { text: rootRespondOutput(policy.policyId), meta: {} };
        if (input.modelStep === "degraded.finalization") {
          degradedAttempts += 1;
          return {
            text: degradedAttempts === 1 ? "invalid" : JSON.stringify(phrasing),
            meta: {},
          };
        }
        return { text: "  ", meta: {} };
      }));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId);
      const result = await runRequestRunner(request);
      const expected = result.output;
      expect(expected).toContain("model returned an invalid decision or response");
      expect(degradedAttempts).toBe(0);

      expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([
        policy.decisionStep,
        ...Array<string>(policy.responseAttempts).fill(policy.responseStep),
      ]);
      expect(result.output).toBe(expected);
      expect(result.finalObservation).toBeUndefined();
      expect(result.memoryCandidates).toBeUndefined();
      expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(expected);
    });

    test("retains valid response behavior without calling degraded finalization", async () => {
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => ({
        text:
          input.modelStep === policy.decisionStep
            ? rootRespondOutput(policy.policyId)
            : "The established result.",
        meta: {},
      })));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId);

      const result = await runRequestRunner(request);

      expect(result.output).toBe("The established result.");
      expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([
        policy.decisionStep,
        policy.responseStep,
      ]);
      if (policy.policyId === "supervisor-worker-v1") {
        expect(invoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
          "supervisor_presentation",
          "supervisor_procedure_gate",
          "supervisor.response",
        ]);
      }
      expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        "The established result.",
      );
    });

    test("successful local repair continues normally instead of terminalizing", async () => {
      let decisionCalls = 0;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
        if (input.modelStep !== policy.decisionStep)
          return { text: "Recovered answer.", meta: {} };
        decisionCalls += 1;
        return {
          text:
            decisionCalls === 1
              ? "invalid"
              : rootRespondOutput(policy.policyId),
          meta: {},
        };
      }));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId);

      await expect(runRequestRunner(request)).resolves.toMatchObject({
        output: "Recovered answer.",
      });
      expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([
        policy.decisionStep,
        policy.decisionStep,
        policy.responseStep,
      ]);
    });
  },
);
