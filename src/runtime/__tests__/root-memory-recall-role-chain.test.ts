import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { REVIEWER_AUDIT_CONTEXT_KIND } from "../steps/reviewer-decision/model-context.js";
import {
  createMemoryRecallHarness,
  FINAL_RESPONSE,
  jsonMessages,
  MEMORY_RECORD,
  modelMessages,
  REQUEST_PROMPT,
  recallCapsules,
  RECALL_QUERY,
  type RecallModelInput,
} from "./support/memory-recall-runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

const PLANNER_OBJECTIVE =
  "Coordinate one bounded result from supplied knowledge.";
const WORKER_OBJECTIVE = "Explain the supplied architectural distinction.";
const WORKER_RESULT =
  "The owner controls canonical state; the adapter executes effects.";
const PLANNER_RESULT = "The Worker explained the requested distinction.";
const REVIEWER_SUMMARY = "The bounded explanation is complete.";

function isWorkingDirectoryCall(input: RecallModelInput): boolean {
  if (typeof input.format !== "object") return false;
  return input.format?.name === "supervisor_working_directory";
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test.each([false, true])(
  "keeps context on the root across the complete Planner Worker Reviewer return chain (scheduled: %s)",
  async (scheduled) => {
    const scheduledExecution = Object.freeze({
      jobId: "root-only-job",
      runId: "root-only-run",
      title: "Saved root task",
      scheduledAt: "2026-09-06T12:00:00.000Z",
      triggerType: "schedule" as const,
    });
    let supervisorCount = 0;
    let plannerCount = 0;
    const harness = createMemoryRecallHarness({
      policy: "supervisor-worker-v1",
      onInput(input) {
        const isRootDecision =
          input.modelStep === "supervisor.decision" &&
          !isWorkingDirectoryCall(input);
        const isRootResponse =
          input.modelStep === "supervisor.response" && !input.format;
        if (isRootDecision && recallCapsules(input).length > 0) {
          const messages = modelMessages(input);
          const recallIndex = messages.findIndex(
            (message) => message.role === "tool" && message.toolName === "recall_memory",
          );
          const childIndex = messages.findIndex(
            ({ content }) => content.includes('"kind":"runtime_child_result"'),
          );
          expect(recallIndex).toBeGreaterThan(messages.findIndex(
            ({ role, content }) => role === "user" && content === REQUEST_PROMPT,
          ));
          if (childIndex >= 0) expect(recallIndex).toBeLessThan(childIndex);
        }
        const origins = jsonMessages(input).filter(
          ({ kind }) => kind === "runtime_scheduled_execution_v1",
        );
        if (scheduled && (isRootDecision || isRootResponse)) {
          expect(origins).toEqual([
            {
              kind: "runtime_scheduled_execution_v1",
              authority: "runtime_scheduler",
              purpose: "execute_saved_task_for_current_run",
              requestId: harness.request.requestId,
              jobId: scheduledExecution.jobId,
              runId: scheduledExecution.runId,
              scheduledAt: scheduledExecution.scheduledAt,
              triggerType: scheduledExecution.triggerType,
              presenceEffect:
                "execution_origin_only_not_new_intent_authorization_or_completion",
            },
          ]);
        } else {
          expect(origins).toEqual([]);
          expect(JSON.stringify(input.messages)).not.toContain(
            scheduledExecution.jobId,
          );
        }
        if (input.modelStep === "supervisor.response") {
          expect(recallCapsules(input)).toEqual([
            expect.objectContaining({
              authority: "passive_reference",
              callId: "call-1",
              steeringVersion: 0,
              recalls: [expect.objectContaining({ memories: [MEMORY_RECORD] })],
            }),
          ]);
          expect(
            jsonMessages(input).some(
              ({ kind }) =>
                kind === "runtime_supervisor_response_recommendation_v1",
            ),
          ).toBe(false);
          expect(
            jsonMessages(input).some(
              ({ kind }) => kind === "runtime_child_result",
            ),
          ).toBe(true);
          expect(
            modelMessages(input).filter(
              ({ role, content }) =>
                role === "user" && content === REQUEST_PROMPT,
            ),
          ).toHaveLength(1);
        }
        const delegatedSteps = [
          "planner.decision",
          "worker.decision",
          "worker.result",
          "reviewer.decision",
        ];
        if (!delegatedSteps.includes(String(input.modelStep))) return;
        expect(recallCapsules(input)).toEqual([]);
        expect(JSON.stringify(input.messages)).not.toContain(
          MEMORY_RECORD.content,
        );
      },
      decide(input) {
        if (isWorkingDirectoryCall(input)) {
          return JSON.stringify({ workingDirectory: "." });
        }
        if (input.modelStep === "supervisor.decision") {
          supervisorCount += 1;
          if (supervisorCount === 1) {
            return {
              action: "recall_memory",
              query: RECALL_QUERY,
              acknowledgement:
                "I will recall context and coordinate the explanation.",
            };
          }
          if (supervisorCount === 2) {
            expect(harness.getAdapters).not.toHaveBeenCalled();
          }
          expect(recallCapsules(input)).toEqual([
            expect.objectContaining({
              callId: "call-1",
              recalls: [
                expect.objectContaining({
                  query: RECALL_QUERY,
                  outcome: "found",
                  memories: [MEMORY_RECORD],
                }),
              ],
            }),
          ]);
          if (supervisorCount === 2) {
            return {
              action: "invoke_role",
              roleId: "planner",
              objective: PLANNER_OBJECTIVE,
            };
          }
          const returned = jsonMessages(input)
            .filter(({ kind }) => kind === "runtime_child_result")
            .at(-1);
          if (supervisorCount === 3) {
            expect(returned).toMatchObject({
              callerCallId: "call-1",
              childCallId: "call-2",
              resultRef: "result-2",
              roleId: "planner",
              summary: PLANNER_RESULT,
            });
            return { action: "invoke_role", roleId: "reviewer" };
          }
          expect(supervisorCount).toBe(4);
          expect(returned).toMatchObject({
            callerCallId: "call-1",
            childCallId: "call-4",
            resultRef: "result-3",
            roleId: "reviewer",
            summary: REVIEWER_SUMMARY,
            reviewerVerdict: {
              kind: "reviewer_verdict_v1",
              verdict: "pass",
            },
          });
          return { action: "respond" };
        }
        if (input.modelStep === "planner.decision") {
          plannerCount += 1;
          if (plannerCount === 1) {
            const assignment = jsonMessages(input).find(
              ({ kind }) => kind === "runtime_planner_assignment",
            );
            expect(assignment).toMatchObject({
              objective: PLANNER_OBJECTIVE,
              workingDirectory: ".",
            });
            return {
              action: "invoke_role",
              roleId: "worker",
              plan: {
                summary: PLANNER_OBJECTIVE,
                items: [
                  {
                    title: "Explain the distinction",
                    objective: WORKER_OBJECTIVE,
                  },
                ],
              },
              selectedItemIndexes: [0],
            };
          }
          expect(
            jsonMessages(input).find(
              ({ kind }) => kind === "runtime_child_result",
            ),
          ).toMatchObject({
            callerCallId: "call-2",
            childCallId: "call-3",
            resultRef: "result-1",
            roleId: "worker",
            delegatedObjective: WORKER_OBJECTIVE,
            summary: WORKER_RESULT,
          });
          return { action: "return_result", result: PLANNER_RESULT };
        }
        if (input.modelStep === "worker.decision") {
          return { action: "return_result" };
        }
        if (input.modelStep === "worker.result") return WORKER_RESULT;
        expect(input.modelStep).toBe("reviewer.decision");
        const assignment = jsonMessages(input).find(
          ({ kind }) => kind === REVIEWER_AUDIT_CONTEXT_KIND,
        ) as {
          auditScope: { reviewScopeId: string };
          dependencySubjects: readonly Record<string, unknown>[];
          effects: readonly { evidenceRef: string }[];
        };
        expect(assignment.dependencySubjects).toEqual([
          expect.objectContaining({
            roleId: "planner",
            objective: PLANNER_OBJECTIVE,
            summary: PLANNER_RESULT,
            outcome: "completed",
          }),
        ]);
        return {
          action: "pass",
          reviewScopeId: assignment.auditScope.reviewScopeId,
          audit: {
            evidenceAssessments: assignment.effects.map(({ evidenceRef }) => ({
              evidenceRef,
              status: "supports",
              finding: "The result establishes the bounded explanation.",
            })),
            completionAssessment: {
              status: "satisfied",
              evidenceRefs: assignment.effects.map(
                ({ evidenceRef }) => evidenceRef,
              ),
              finding: "The supplied result answers the bounded objective.",
            },
          },
          summary: REVIEWER_SUMMARY,
          gaps: [],
        };
      },
    });
    const request = scheduled
      ? deriveTestRequestExecutionScope(harness.request, { scheduledExecution })
      : harness.request;
    await expect(runRequestRunner(request)).resolves.toMatchObject({
      output: FINAL_RESPONSE,
    });
    const modelSteps = harness.invoke.mock.calls
      .filter(([input]) => !isWorkingDirectoryCall(input))
      .map(([input]) => input.modelStep);
    expect(modelSteps).toEqual([
      "supervisor.decision",
      "supervisor.decision",
      "planner.decision",
      "worker.decision",
      "worker.result",
      "planner.decision",
      "supervisor.decision",
      "reviewer.decision",
      "supervisor.decision",
      "supervisor.response",
      "supervisor.response",
    ]);
    expect(harness.memory.retrieve).toHaveBeenCalledOnce();
    expect(harness.invokeRaw).not.toHaveBeenCalled();
    expect(harness.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
      FINAL_RESPONSE,
    );
  },
);
