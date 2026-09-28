import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  createInvalidOutputRequest,
  readInvalidOutputCapsules,
  type InvalidOutputModelInput,
} from "./support/invalid-output-request.js";

type FailureStep =
  | "worker.decision"
  | "worker.result"
  | "planner.decision"
  | "reviewer.decision"
  | "none";
type ScriptEntry = Readonly<{
  step: InvalidOutputModelInput["modelStep"];
  output: string | ((input: InvalidOutputModelInput) => string);
  providerCompletionReason?: "length";
  timeout?: boolean;
}>;

const REJECTED_OUTPUT = "INVALID_MODEL_OUTPUT_SENTINEL";
const FINAL_OUTPUT =
  "The bounded work is reported with its validation outcome.";
const RESULT = "The requested bounded report is ready for independent review.";
const PLANNER_OBJECTIVE = "Coordinate the requested bounded report.";
const WORKER_OBJECTIVE = "Produce the requested bounded report.";
const decision = (value: unknown) => JSON.stringify({ decision: value });

function invalidAttempts(
  step: FailureStep,
  providerCompletionReason?: "length",
  timeout = false,
): ScriptEntry[] {
  if (step === "none") return [];
  if (timeout) return [{ step, output: REJECTED_OUTPUT, timeout }];
  if (providerCompletionReason) {
    return [{ step, output: REJECTED_OUTPUT, providerCompletionReason }];
  }
  return Array.from({ length: step === "worker.result" ? 2 : 3 }, () => ({
    step,
    output: step === "worker.result" ? "" : REJECTED_OUTPUT,
  }));
}

function readReturnedChild(input: InvalidOutputModelInput) {
  const results = readInvalidOutputCapsules(input, "runtime_child_result");
  expect(results.length).toBeGreaterThan(0);
  expect(JSON.stringify(results)).not.toContain(REJECTED_OUTPUT);
  return results.at(-1)!;
}

function workerOutputFailed(step: FailureStep): boolean {
  if (step === "worker.decision") return true;
  return step === "worker.result";
}

function plannerOutputFailed(step: FailureStep): boolean {
  if (workerOutputFailed(step)) return true;
  return step === "planner.decision";
}

function reviewerGap(input: InvalidOutputModelInput): string {
  const audit = readInvalidOutputCapsules(
    input,
    "runtime_reviewer_audit_v4",
  ).at(-1)!;
  return decision({
    action: "report_gaps",
    reviewScopeId: audit.auditScope.reviewScopeId,
    summary:
      "Independent evidence does not establish the full requested outcome.",
    audit: {
      evidenceAssessments: audit.effects.map(
        (effect: { evidenceRef: string }) => ({
          evidenceRef: effect.evidenceRef,
          status: "insufficient",
          finding: "This evidence does not establish the full outcome.",
        }),
      ),
      completionAssessment: {
        status: "gap",
        evidenceRefs: [],
        finding: "Independent outcome verification is unavailable.",
      },
    },
    gaps: [
      {
        kind: "missing_evidence",
        subjectRefs: [],
        factRefs: [],
        evidenceRefs: [],
        summary: "Independent outcome verification is unavailable.",
      },
    ],
  });
}

function createScript(
  failureStep: FailureStep,
  providerCompletionReason?: "length",
  timeout = false,
): ScriptEntry[] {
  const workerFailed = workerOutputFailed(failureStep);
  const plannerFailed = plannerOutputFailed(failureStep);
  const script: ScriptEntry[] = [
    {
      step: "supervisor.decision",
      output: decision({
        action: "invoke_role",
        roleId: "planner",
        objective: PLANNER_OBJECTIVE,
        acknowledgement: "I will produce and review the bounded report.",
      }),
    },
    {
      step: "supervisor.decision",
      output: JSON.stringify({ workingDirectory: "." }),
    },
    {
      step: "planner.decision",
      output: decision({
        action: "invoke_role",
        roleId: "worker",
        plan: {
          summary: PLANNER_OBJECTIVE,
          items: [{ title: "Produce report", objective: WORKER_OBJECTIVE }],
        },
        selectedItemIndexes: [0],
      }),
    },
  ];
  if (failureStep === "worker.decision") {
    script.push(
      ...invalidAttempts(failureStep, providerCompletionReason, timeout),
    );
  } else {
    script.push({
      step: "worker.decision",
      output: decision({ action: "return_result" }),
    });
    script.push(
      ...(failureStep === "worker.result"
        ? invalidAttempts(failureStep, providerCompletionReason, timeout)
        : [{ step: "worker.result" as const, output: RESULT }]),
    );
  }
  if (failureStep === "planner.decision") {
    script.push(
      ...invalidAttempts(failureStep, providerCompletionReason, timeout).map(
        (entry) => ({
          ...entry,
          output(input: InvalidOutputModelInput) {
            expect(readReturnedChild(input)).toMatchObject({
              callerCallId: "call-2",
              childCallId: "call-3",
              roleId: "worker",
              outcome: "completed",
              workReceipt: { kind: "work_result_v1", callerCallId: "call-2" },
            });
            return REJECTED_OUTPUT;
          },
        }),
      ),
    );
  } else {
    script.push({
      step: "planner.decision",
      output(input) {
        const returned = readReturnedChild(input);
        expect(returned).toMatchObject({
          callerCallId: "call-2",
          childCallId: "call-3",
          roleId: "worker",
          outcome: workerFailed ? "failed" : "completed",
          workReceipt: { kind: "work_result_v1", callerCallId: "call-2" },
        });
        if (providerCompletionReason) {
          expect(JSON.parse(returned.summary)).toMatchObject({
            reason: "output_incomplete",
            modelStep: failureStep,
            validationStage: "provider_completion",
            callId: "call-3",
            parentCallId: "call-2",
          });
        }
        if (timeout && workerFailed) {
          expect(JSON.parse(returned.summary)).toMatchObject({
            reason: failureStep.replace(".", "_") + "_timeout",
            modelStep: failureStep,
            validationStage: "model_step_timeout",
          });
        }
        return workerFailed
          ? decision({
              action: "return_failure",
              reason: "The Worker output was invalid.",
            })
          : decision({ action: "return_result", result: RESULT });
      },
    });
  }
  script.push({
    step: "supervisor.decision",
    output(input) {
      expect(readReturnedChild(input)).toMatchObject({
        callerCallId: "call-1",
        childCallId: "call-2",
        roleId: "planner",
        outcome: plannerFailed ? "failed" : "completed",
        workReceipt: { kind: "work_result_v1", callerCallId: "call-1" },
        workLineage: {
          planner: {
            items: [
              {
                itemId: "plan-call-2-item-1",
                status: workerFailed ? "blocked" : "done",
                resultRef: "result-1",
              },
            ],
          },
        },
      });
      if (timeout && failureStep === "planner.decision") {
        expect(JSON.parse(readReturnedChild(input).summary)).toMatchObject({
          reason: "planner_decision_timeout",
          modelStep: failureStep,
          validationStage: "model_step_timeout",
        });
      }
      return decision({ action: "invoke_role", roleId: "reviewer" });
    },
  });
  const reviewerEntries =
    failureStep === "reviewer.decision"
      ? invalidAttempts(failureStep, providerCompletionReason, timeout)
      : [{ step: "reviewer.decision" as const, output: reviewerGap }];
  script.push(
    ...reviewerEntries.map((entry) => ({
      ...entry,
      output(input: InvalidOutputModelInput) {
        const audit = readInvalidOutputCapsules(
          input,
          "runtime_reviewer_audit_v4",
        ).at(-1)!;
        expect(audit.dependencySubjects).toEqual([
          expect.objectContaining({
            roleId: "planner",
            outcome: plannerFailed ? "failed" : "completed",
          }),
        ]);
        return typeof entry.output === "string"
          ? entry.output
          : entry.output(input);
      },
    })),
  );
  script.push(
    {
      step: "supervisor.decision",
      output(input) {
        const returned = readReturnedChild(input);
        expect(returned).toMatchObject({
          callerCallId: "call-1",
          childCallId: "call-4",
          roleId: "reviewer",
          outcome: failureStep === "reviewer.decision" ? "failed" : "completed",
        });
        if (failureStep !== "reviewer.decision") {
          expect(returned.reviewerVerdict).toMatchObject({
            verdict: "report_gaps",
          });
          return decision({ action: "respond" });
        }
        expect(returned).not.toHaveProperty("reviewerVerdict");
        if (timeout) {
          expect(JSON.parse(returned.summary)).toMatchObject({
            reason: "reviewer_decision_timeout",
            modelStep: failureStep,
            validationStage: "model_step_timeout",
          });
        }
        return decision({ action: "respond" });
      },
    },
    { step: "supervisor.response", output: FINAL_OUTPUT },
  );
  return script;
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("invalid output across the complete delegated request", () => {
  test.each([
    { failureStep: "worker.decision" },
    { failureStep: "worker.result" },
    { failureStep: "planner.decision" },
    { failureStep: "reviewer.decision" },
    { failureStep: "none" },
    { failureStep: "worker.decision", providerCompletionReason: "length" },
    { failureStep: "worker.result", providerCompletionReason: "length" },
    { failureStep: "worker.decision", timeout: true },
    { failureStep: "worker.result", timeout: true },
    { failureStep: "planner.decision", timeout: true },
    { failureStep: "reviewer.decision", timeout: true },
  ] satisfies {
    failureStep: FailureStep;
    providerCompletionReason?: "length";
    timeout?: boolean;
  }[])(
    "$failureStep ($providerCompletionReason, timeout=$timeout) preserves child return, plan state and independent review",
    async ({ failureStep, providerCompletionReason, timeout }) => {
      const script = createScript(
        failureStep,
        providerCompletionReason,
        timeout,
      );
      let next = 0;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
        const entry = script[next++];
        expect(
          entry,
          `unexpected model step: ${input.modelStep}`,
        ).toBeDefined();
        expect(input.modelStep).toBe(entry!.step);
        const text =
          typeof entry!.output === "string"
            ? entry!.output
            : entry!.output(input);
        if (entry!.timeout) {
          await new Promise<never>((_resolve, reject) => {
            input.abortSignal!.addEventListener(
              "abort",
              () => reject(input.abortSignal!.reason),
              { once: true },
            );
          });
        }
        return {
          text,
          meta: { providerCompletionReason: entry!.providerCompletionReason },
        };
      });
      const initialRequest = createInvalidOutputRequest(invoke);
      const request = timeout
        ? deriveTestRequestExecutionScope(initialRequest, {
            runnerConfig: {
              ...initialRequest.runnerConfig,
              steps: {
                ...initialRequest.runnerConfig.steps,
                [failureStep]: { timeoutMs: 5 },
              },
            },
          })
        : initialRequest;
      await expect(runRequestRunner(request)).resolves.toEqual({
        output: FINAL_OUTPUT,
      });
      expect(next).toBe(script.length);
      if (providerCompletionReason) {
        expect(
          invoke.mock.calls.filter(
            ([input]) => input.modelStep === failureStep,
          ),
        ).toHaveLength(1);
      }
      expect(script.filter((entry) => entry.timeout)).toHaveLength(
        timeout ? 1 : 0,
      );
      expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        FINAL_OUTPUT,
      );
      expect(request.modelGatewayClient!.invokeRaw).not.toHaveBeenCalled();
    },
  );
});
