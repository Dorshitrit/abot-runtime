import { rootWorkCalls } from "./support/root-invalid-output-fixture.js";
import { withSupervisorPreparation } from "./support/supervisor-model-phases.js";
import { buildDegradedFinalizationFallback } from "../steps/degraded-finalization/fallback.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveRoleCallTransactions } from "../orchestration/role-calls/index.js";
import { StructuredModelInvalidOutputError } from "../model/invoke-structured-step.js";
import { ModelOutputIncompleteError } from "../model/provider-completion.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
  INVALID_OUTPUT_RUNNER_CONFIG,
  ROOT_OUTPUT_POLICIES,
  rootRespondOutput,
} from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe.each(ROOT_OUTPUT_POLICIES)(
  "$policyId invalid-output safety boundaries",
  (policy) => {
    test.each(["decision", "response"] as const)(
      "propagates provider exceptions during %s without a degraded answer",
      async (phase) => {
        const failure = new Error("provider_connection_failed");
        const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
          if (phase === "response" && input.modelStep === policy.decisionStep)
            return { text: rootRespondOutput(policy.policyId), meta: {} };
          throw failure;
        }));
        const request = createRootInvalidOutputRequest(invoke, policy.policyId);

        await expect(runRequestRunner(request)).rejects.toBe(failure);
        expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual(
          phase === "decision"
            ? [policy.decisionStep]
            : [policy.decisionStep, policy.responseStep],
        );
        expect(request.onAnswerToken).not.toHaveBeenCalled();
      },
    );

    test("does not classify a provider error by an invalid-looking message", async () => {
      const failure = new Error(policy.invalidDecision);
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async () => {
        throw failure;
      }));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId);

      await expect(runRequestRunner(request)).rejects.toBe(failure);
      expect(rootWorkCalls(invoke)).toHaveLength(1);
      expect(request.onAnswerToken).not.toHaveBeenCalled();
    });

    test("preserves the model timeout boundary without degraded finalization", async () => {
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(
        withSupervisorPreparation(async (input) =>
          new Promise((_, reject) => {
            input.abortSignal.addEventListener(
              "abort",
              () => reject(input.abortSignal.reason),
              { once: true },
            );
          })),
      );
      const request = createRootInvalidOutputRequest(invoke, policy.policyId, {
        runnerConfig: {
          ...INVALID_OUTPUT_RUNNER_CONFIG,
          steps: {
            ...INVALID_OUTPUT_RUNNER_CONFIG.steps,
            [policy.decisionStep]: { timeoutMs: 5 },
          },
        },
      });

      await expect(runRequestRunner(request)).rejects.toThrow(
        policy.policyId === "supervisor-worker-v1"
          ? "supervisor_decision_timeout"
          : "execution_agent_decision_timeout",
      );
      expect(rootWorkCalls(invoke)).toHaveLength(1);
      expect(request.onAnswerToken).not.toHaveBeenCalled();
    });

    test("parent cancellation wins over malformed output", async () => {
      const abort = new AbortController();
      const failure = new Error("user_cancelled_root_output");
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async () => {
        abort.abort(failure);
        return { text: "invalid", meta: {} };
      }));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId, {
        abortSignal: abort.signal,
      });

      await expect(runRequestRunner(request)).rejects.toBe(failure);
      expect(rootWorkCalls(invoke)).toHaveLength(1);
      expect(request.onAnswerToken).not.toHaveBeenCalled();
    });

    test("a decision invalidated by fresh steering restarts without terminalizing", async () => {
      const steering = createRequestSteeringInbox({
        requestId: "root-invalid-request",
      });
      let decisions = 0;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
        if (input.modelStep !== policy.decisionStep)
          return { text: "Answer for the fresh instruction.", meta: {} };
        decisions += 1;
        if (decisions === 3)
          steering.append({
            steerId: "fresh-invalid",
            text: "Use the fresh instruction.",
          });
        return {
          text: decisions <= 3 ? "invalid" : rootRespondOutput(policy.policyId),
          meta: {},
        };
      }));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId, {
        requestSteering: steering,
      });

      const result = await runRequestRunner(request);

      expect(result.output).toBe("Answer for the fresh instruction.");
      expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([
        ...Array<string>(4).fill(policy.decisionStep),
        policy.responseStep,
      ]);
      expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        result.output,
      );
      const freshDecision = rootWorkCalls(invoke)[3]![0];
      expect(JSON.stringify(freshDecision.messages)).toContain(
        "Use the fresh instruction.",
      );
    });

    test("discards unknown-failure phrasing superseded by fresh steering", async () => {
      const steering = createRequestSteeringInbox({
        requestId: "root-invalid-request",
      });
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
        if (input.modelStep === "degraded.finalization") {
          steering.append({
            steerId: "fresh-degraded",
            text: "Apply the new direction.",
          });
          return {
            text: JSON.stringify({
              failureNotice: "STALE FAILURE",
              nextStep: "STALE NEXT STEP",
            }),
            meta: {},
          };
        }
        if (input.modelStep === policy.decisionStep) {
          if (steering.snapshot().version === 0)
            throw new ModelOutputIncompleteError({
              outputLength: 0,
              providerCompletionReason: "unknown",
              steeringVersion: 0,
            }, policy.decisionStep);
          return {
            text: rootRespondOutput(policy.policyId),
            meta: {},
          };
        }
        return { text: "Fresh result after steering.", meta: {} };
      }));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId, {
        requestSteering: steering,
      });

      const result = await runRequestRunner(request);

      expect(result.output).toBe("Fresh result after steering.");
      expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([
        policy.decisionStep,
        "degraded.finalization",
        policy.decisionStep,
        policy.responseStep,
      ]);
      expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        result.output,
      );
      expect(JSON.stringify(result)).not.toContain("STALE");
    });

    test("preserves the primary failure when the verified notice cannot fit", async () => {
      const ledger = await createRootInvalidOutputLedger(policy.policyId, 8);
      const initialHead = ledger.current();
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async () => ({
        text: "invalid",
        meta: {},
      })));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId);

      await expect(
        runRootExecutionKernel({ request, ledger }),
      ).rejects.toMatchObject({
        name: "StructuredModelInvalidOutputError",
        message: policy.invalidDecision,
        modelStep: policy.decisionStep,
        repairAttempts: 2,
      });
      expect(ledger.current()).toBe(initialHead);
      expect(ledger.current().policy.limits.maxResponseChars).toBe(8);
      expect(ledger.current().state).toMatchObject({
        phase: "running",
        activeCallId: "call-1",
        rootResponse: null,
      });
      expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([
        ...Array<string>(3).fill(policy.decisionStep),
      ]);
      expect(request.onAnswerToken).not.toHaveBeenCalled();
    });

    test("preserves policy behavior when unknown-failure authoring fails", async () => {
      const ledger = await createRootInvalidOutputLedger(policy.policyId);
      const initialHead = ledger.current();
      const failure = new Error("degraded_provider_connection_failed");
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
        if (input.modelStep === "degraded.finalization") throw failure;
        throw new ModelOutputIncompleteError({
          outputLength: 0,
          providerCompletionReason: "unknown",
        }, policy.decisionStep);
      }));
      const request = createRootInvalidOutputRequest(invoke, policy.policyId);

      if (policy.policyId === "supervisor-worker-v1") {
        const expected = buildDegradedFinalizationFallback({
          problem: { stage: policy.decisionStep, code: "output_incomplete" },
          progress: null,
        });
        await expect(
          runRootExecutionKernel({ request, ledger }),
        ).resolves.toMatchObject({ output: expected, disposition: "blocked" });
        expect(ledger.current().state.rootResponse).toBe(expected);
        expect(
          invoke.mock.calls.filter(
            ([input]) => input.modelStep === "degraded.finalization",
          ),
        ).toHaveLength(1);
        return;
      }
      await expect(runRootExecutionKernel({ request, ledger })).rejects.toBe(
        failure,
      );
      expect(ledger.current()).toBe(initialHead);
      expect(rootWorkCalls(invoke).map(([input]) => input.modelStep)).toEqual([
        policy.decisionStep,
        "degraded.finalization",
      ]);
      expect(request.onAnswerToken).not.toHaveBeenCalled();
    });

    test("refuses to complete an invalid output against a changed ledger head", async () => {
      const ledger = await createRootInvalidOutputLedger(policy.policyId);
      const failure = new StructuredModelInvalidOutputError(
        policy.invalidDecision,
        policy.decisionStep,
        {
          validationStage: "decision",
          issues: [],
          repairAttempts: 2,
          repeatedInvalidOutput: true,
        },
      );
      const basePolicy = resolveRequestExecutionPolicy(policy.policyId);
      const invoke = vi.fn<ModelGatewayClient["invoke"]>();
      const request = createRootInvalidOutputRequest(
        invoke,
        policy.policyId,
        {},
        {
          ...basePolicy,
          rootContract: {
            ...basePolicy.rootContract,
            async decide() {
              const head = ledger.current();
              const completed = await resolveRoleCallTransactions(
                ledger,
              ).completeRootResponse({
                expectedHead: head,
                callId: head.state.rootCallId!,
                response: "Already committed by another owner.",
              });
              if (!completed.ok) throw new Error(completed.issueCode);
              throw failure;
            },
          },
        },
      );

      await expect(runRootExecutionKernel({ request, ledger })).rejects.toBe(
        failure,
      );
      expect(invoke).not.toHaveBeenCalled();
      expect(ledger.current().state.rootResponse).toBe(
        "Already committed by another owner.",
      );
      expect(request.onAnswerToken).not.toHaveBeenCalled();
    });
  },
);
