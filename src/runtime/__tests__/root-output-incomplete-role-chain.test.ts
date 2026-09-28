import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import { renderDegradedFinalization } from "../steps/degraded-finalization/render.js";
import {
  readInvalidOutputCapsules,
  type InvalidOutputModelInput,
} from "./support/invalid-output-request.js";
import { createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";

type Entry = Readonly<{
  step: InvalidOutputModelInput["modelStep"];
  output: string | ((input: InvalidOutputModelInput) => string);
  incomplete?: boolean;
}>;
const decision = (value: unknown) => JSON.stringify({ decision: value });
const WORK_RESULT = "The requested distinction has been explained.";
const PHRASING = {
  failureNotice: "The final model output did not complete.",
  nextStep: "Continue from the recorded work in a follow-up request.",
};

function returnedChild(input: InvalidOutputModelInput) {
  return readInvalidOutputCapsules(input, "runtime_child_result").at(-1)!;
}

function createReviewedWorkScript(): Entry[] {
  return [
    {
      step: "supervisor.decision",
      output: decision({
        action: "invoke_role",
        roleId: "planner",
        objective: "Coordinate an explanation of the supplied distinction.",
        acknowledgement: "I will produce and review the explanation.",
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
          summary: "Produce the requested explanation.",
          items: [
            {
              title: "Explain distinction",
              objective: "Explain the supplied distinction.",
            },
          ],
        },
        selectedItemIndexes: [0],
      }),
    },
    { step: "worker.decision", output: decision({ action: "return_result" }) },
    { step: "worker.result", output: WORK_RESULT },
    {
      step: "planner.decision",
      output(input) {
        expect(returnedChild(input)).toMatchObject({
          callerCallId: "call-2",
          childCallId: "call-3",
          outcome: "completed",
          summary: WORK_RESULT,
          workReceipt: { kind: "work_result_v1", producerCallId: "call-3" },
        });
        return decision({ action: "return_result", result: WORK_RESULT });
      },
    },
    {
      step: "supervisor.decision",
      output(input) {
        expect(returnedChild(input)).toMatchObject({
          callerCallId: "call-1",
          childCallId: "call-2",
          roleId: "planner",
          outcome: "completed",
          summary: WORK_RESULT,
          workLineage: {
            planner: {
              items: [{ itemId: "plan-call-2-item-1", status: "done" }],
            },
          },
        });
        return decision({ action: "invoke_role", roleId: "reviewer" });
      },
    },
    {
      step: "reviewer.decision",
      output(input) {
        const audit = readInvalidOutputCapsules(
          input,
          "runtime_reviewer_audit_v4",
        ).at(-1)!;
        expect(audit.dependencySubjects).toEqual([
          expect.objectContaining({
            roleId: "planner",
            summary: WORK_RESULT,
            outcome: "completed",
          }),
        ]);
        return decision({
          action: "pass",
          reviewScopeId: audit.auditScope.reviewScopeId,
          summary: "The explanation satisfies the supplied objective.",
          audit: {
            evidenceAssessments: [],
            completionAssessment: {
              status: "satisfied",
              evidenceRefs: [],
              finding: "The supplied explanation establishes the distinction.",
            },
          },
          gaps: [],
        });
      },
    },
  ];
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each(["decision", "response"] as const)(
  "retains reviewed canonical work when final root %s is incomplete",
  async (phase) => {
    const script = createReviewedWorkScript();
    script.push({
      step: "supervisor.decision",
      output(input) {
        expect(returnedChild(input)).toMatchObject({
          callerCallId: "call-1",
          childCallId: "call-4",
          roleId: "reviewer",
          reviewerVerdict: { verdict: "pass" },
        });
        return decision({ action: "respond" });
      },
      incomplete: phase === "decision",
    });
    if (phase === "response") {
      script.push({
        step: "supervisor.response",
        output: "INCOMPLETE_FINAL_ANSWER",
        incomplete: true,
      });
    }
    script.push({
      step: "degraded.finalization",
      output: JSON.stringify(PHRASING),
    });
    let next = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const entry = script[next++];
      expect(entry, `unexpected model step: ${input.modelStep}`).toBeDefined();
      expect(input.modelStep).toBe(entry!.step);
      return {
        text:
          typeof entry!.output === "string"
            ? entry!.output
            : entry!.output(input),
        meta: entry!.incomplete ? { providerCompletionReason: "length" } : {},
      };
    });
    const request = createRootInvalidOutputRequest(invoke);
    const result = await runRequestRunner(request);
    const expected = renderDegradedFinalization({
      phrasing: PHRASING,
      input: {
        problem: { stage: "provider_completion", code: "output_incomplete" },
        progress: {
          planSummary: "",
          completed: [
            { id: "plan-call-2-item-1", title: "Explain distinction" },
          ],
          unresolved: [],
        },
      },
    });
    expect(result.output).toBe(expected);
    expect(result.finalObservation).toBeUndefined();
    expect(result.memoryCandidates).toBeUndefined();
    expect(next).toBe(script.length);
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(expected);
    expect(request.modelGatewayClient.invokeRaw).not.toHaveBeenCalled();
  },
);
