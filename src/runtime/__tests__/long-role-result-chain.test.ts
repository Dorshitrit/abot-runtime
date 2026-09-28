import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { REVIEWER_ITEM_SUMMARY_MAX_LENGTH } from "../steps/reviewer-decision/contracts.js";
import {
  createInvalidOutputRequest,
  readInvalidOutputCapsules,
  type InvalidOutputModelInput,
} from "./support/invalid-output-request.js";

type ModelEntry = Readonly<{
  step: InvalidOutputModelInput["modelStep"];
  output: string | ((input: InvalidOutputModelInput) => string);
}>;

const WORKER_RESULT = "Observed source detail. ".repeat(450) + "SOURCE_END";
const PLANNER_RESULT = "Integrated finding with supporting context. ".repeat(240) + "PLAN_END";
const SECOND_RESULT = "The complete supplied source was assessed.";
const PLANNER_OBJECTIVE = "Coordinate the source assessment and its report.";
const FINAL_OUTPUT = "The source assessment and independent review are complete.";
const decision = (value: unknown) => JSON.stringify({ decision: value });

function returnedChild(input: InvalidOutputModelInput) {
  return readInvalidOutputCapsules(input, "runtime_child_result").at(-1)!;
}

function assertSourceDependency(
  input: InvalidOutputModelInput,
  kind: string,
  includesReceipt: boolean,
) {
  const assignment = readInvalidOutputCapsules(input, kind).at(-1)!;
  expect(assignment).toMatchObject({ callId: "call-4", parentCallId: "call-2" });
  expect(assignment.dependencyResults).toHaveLength(1);
  const dependency = assignment.dependencyResults[0];
  expect(dependency).toMatchObject({
    producerCallId: "call-3",
    resultRef: "result-1",
    roleId: "worker",
    outcome: "completed",
    summary: WORKER_RESULT,
  });
  if (!includesReceipt) {
    expect(dependency).not.toHaveProperty("receipt");
    expect(dependency).not.toHaveProperty("workLineage");
    return;
  }
  expect(dependency.receipt).toMatchObject({
    kind: "work_result_v1",
    producerCallId: "call-3",
    callerCallId: "call-2",
  });
}

function independentReview(
  input: InvalidOutputModelInput,
  plannerFailed: boolean,
): string {
  const audit = readInvalidOutputCapsules(input, "runtime_reviewer_audit_v4").at(-1)!;
  expect(audit.dependencySubjects).toEqual([
    expect.objectContaining({
      roleId: "planner",
      summary: PLANNER_RESULT.slice(0, REVIEWER_ITEM_SUMMARY_MAX_LENGTH).trim(),
      outcome: plannerFailed ? "failed" : "completed",
    }),
  ]);
  expect(audit.effects).toEqual([]);
  return decision({
    action: "report_gaps",
    reviewScopeId: audit.auditScope.reviewScopeId,
    summary: "The independent review reflects the supplied result.",
    audit: {
      evidenceAssessments: [],
      completionAssessment: {
        status: "gap",
        evidenceRefs: [],
        finding: "The supplied result establishes the assessment outcome.",
      },
    },
    gaps: [{
      kind: "missing_evidence",
      subjectRefs: [],
      factRefs: [],
      evidenceRefs: [],
      summary: "The bounded review projection does not establish full completion.",
    }],
  });
}

function createLongResultScript(plannerFailed: boolean): ModelEntry[] {
  return [
    {
      step: "supervisor.decision",
      output: decision({
        action: "invoke_role",
        roleId: "planner",
        objective: PLANNER_OBJECTIVE,
        acknowledgement: "I will coordinate and independently review the assessment.",
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
          items: [
            { title: "Source", objective: "Describe the supplied source." },
            { title: "Assessment", objective: "Assess the returned source detail." },
          ],
        },
        selectedItemIndexes: [0],
      }),
    },
    { step: "worker.decision", output: decision({ action: "return_result" }) },
    { step: "worker.result", output: WORKER_RESULT },
    {
      step: "planner.decision",
      output(input) {
        expect(returnedChild(input)).toMatchObject({
          callerCallId: "call-2",
          childCallId: "call-3",
          resultRef: "result-1",
          roleId: "worker",
          outcome: "completed",
          summary: WORKER_RESULT,
          workReceipt: {
            kind: "work_result_v1",
            producerCallId: "call-3",
            callerCallId: "call-2",
          },
        });
        return decision({
          action: "invoke_role",
          roleId: "worker",
          planItemIds: ["plan-call-2-item-2"],
        });
      },
    },
    {
      step: "worker.decision",
      output(input) {
        assertSourceDependency(input, "runtime_worker_assignment", true);
        return decision({ action: "return_result" });
      },
    },
    {
      step: "worker.result",
      output(input) {
        assertSourceDependency(input, "runtime_worker_result_assignment", false);
        return SECOND_RESULT;
      },
    },
    {
      step: "planner.decision",
      output(input) {
        expect(returnedChild(input)).toMatchObject({
          childCallId: "call-4",
          resultRef: "result-2",
          summary: SECOND_RESULT,
          outcome: "completed",
          dependencyResultRefs: ["result-1"],
        });
        return plannerFailed
          ? decision({ action: "return_failure", reason: PLANNER_RESULT })
          : decision({ action: "return_result", result: PLANNER_RESULT });
      },
    },
    {
      step: "supervisor.decision",
      output(input) {
        expect(returnedChild(input)).toMatchObject({
          callerCallId: "call-1",
          childCallId: "call-2",
          resultRef: "result-3",
          roleId: "planner",
          outcome: plannerFailed ? "failed" : "completed",
          summary: PLANNER_RESULT,
          workReceipt: {
            kind: "work_result_v1",
            producerCallId: "call-2",
            callerCallId: "call-1",
          },
          workLineage: {
            planner: {
              items: [
                { itemId: "plan-call-2-item-1", status: "done", resultRef: "result-1" },
                { itemId: "plan-call-2-item-2", status: "done", resultRef: "result-2" },
              ],
            },
          },
        });
        return decision({ action: "invoke_role", roleId: "reviewer" });
      },
    },
    {
      step: "reviewer.decision",
      output: (input) => independentReview(input, plannerFailed),
    },
    {
      step: "supervisor.decision",
      output(input) {
        expect(returnedChild(input)).toMatchObject({
          callerCallId: "call-1",
          childCallId: "call-5",
          resultRef: "result-4",
          roleId: "reviewer",
          outcome: "completed",
          reviewerVerdict: {
            verdict: "report_gaps",
          },
        });
        return decision({ action: "respond" });
      },
    },
    { step: "supervisor.response", output: FINAL_OUTPUT },
  ];
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each([false, true])(
  "preserves long prose through Worker, sibling authoring, Planner and independent review (Planner failed: %s)",
  async (plannerFailed) => {
    expect(WORKER_RESULT.length).toBeGreaterThan(8_192);
    expect(PLANNER_RESULT.length).toBeGreaterThan(8_192);
    const script = createLongResultScript(plannerFailed);
    let next = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const entry = script[next++];
      expect(entry, `unexpected model step: ${input.modelStep}`).toBeDefined();
      expect(input.modelStep).toBe(entry!.step);
      return {
        text: typeof entry!.output === "string" ? entry!.output : entry!.output(input),
        meta: {},
      };
    });
    const request = createInvalidOutputRequest(invoke);
    await expect(runRequestRunner(request)).resolves.toEqual({ output: FINAL_OUTPUT });
    expect(next).toBe(script.length);
    expect(invoke.mock.calls.filter(([input]) => input.modelStep === "worker.result"))
      .toHaveLength(2);
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(FINAL_OUTPUT);
    expect(request.modelGatewayClient!.invokeRaw).not.toHaveBeenCalled();
  },
);
