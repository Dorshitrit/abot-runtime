import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createRoleCallLedger,
  resolveRoleCallTransactions,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallLedgerHead,
  type RoleCallResult,
} from "../orchestration/role-calls/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { projectExecutionChildContinuations } from "../steps/execution-agent/child-continuation.js";

const OBJECTIVE = 'Plan the exact "deliverable".\nKeep שלום and all requested constraints.';
const SUMMARY = '  {"proposal":"quoted \"text\"","line":"first\\nsecond"}\nשלום  ';

async function createReturnedChild(
  outcome: "completed" | "failed" = "completed",
  authority: ExecutionPolicyAuthoritySnapshot = EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
) {
  const ledger = createRoleCallLedger({
    requestId: "child-continuation-request",
    policy: { authority, limits: {
      maxDepth: 4, maxCalls: 12, maxCapabilityExecutions: 16,
      maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536,
    } },
  });
  const transactions = resolveRoleCallTransactions(ledger);
  const root = await transactions.createRoot({ expectedHead: ledger.current() });
  if (!root.ok) throw new Error("fixture_root_failed");
  const callerCallId = ledger.current().state.rootCallId!;
  const opened = await transactions.openChild({
    expectedHead: ledger.current(), callerCallId, roleId: "planner", objective: OBJECTIVE,
  });
  if (!opened.ok) throw new Error("fixture_child_failed");
  const childCallId = opened.commit.effect.childCallId;
  const returned = await transactions.returnChild({
    expectedHead: ledger.current(), callerCallId, childCallId, outcome, summary: SUMMARY,
  });
  if (!returned.ok) throw new Error(`fixture_return_failed:${returned.issueCode}`);
  const head = ledger.current();
  const call = head.state.calls.find(({ callId }) => callId === callerCallId)!;
  const child = head.state.calls.find(({ callId }) => callId === childCallId)!;
  const result = head.state.results.find(({ resultRef }) => resultRef === child.resultRef)!;
  return { head, call, child, result };
}

function replaceResult(head: RoleCallLedgerHead, result: RoleCallResult): RoleCallLedgerHead {
  return { ...head, state: { ...head.state, results: [result] } };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("Execution Agent canonical child continuation", () => {
  test.each(["completed", "failed"] as const)("links an exact %s child result to its accepted invocation", async (outcome) => {
    const { head, call, child, result } = await createReturnedChild(outcome);
    const before = JSON.stringify(head);
    const continuations = projectExecutionChildContinuations(head, call);
    expect(continuations).toHaveLength(1);
    const continuation = continuations[0]!;
    expect(continuation.invocationAttempt).toBe(child.parentInvocationAttempt);
    expect(continuation.resultRef).toBe(result.resultRef);
    const [actionMessage, resultMessage] = continuation.messages;
    if (actionMessage?.role !== "assistant" || !actionMessage.toolCalls || resultMessage?.role !== "tool")
      throw new Error("expected_native_pair");
    const toolCall = actionMessage.toolCalls[0]!;
    expect(toolCall.callId).toBe(`role-call:${child.callId}`);
    expect(resultMessage.toolCallId).toBe(toolCall.callId);
    expect(toolCall.name).toBe("runtime_role");
    expect(resultMessage.toolName).toBe(toolCall.name);
    expect(actionMessage.content).toBe("");
    const action = JSON.parse(toolCall.arguments);
    const returned = JSON.parse(resultMessage.content);
    const binding = {
      callerCallId: call.callId, childCallId: child.callId,
      roleId: "planner", parentInvocationAttempt: child.parentInvocationAttempt,
    };
    expect(action).toMatchObject({ ...binding, objective: child.objective });
    expect(returned).toMatchObject(binding);
    expect(action.objective).toBe(OBJECTIVE);
    expect(returned.result).toEqual({ resultRef: result.resultRef, outcome, summary: result.summary });
    expect(returned.result.summary).toBe(SUMMARY.trim());
    expect(returned.summaryAuthority).toBe("child_report_not_independent_verification");
    expect(returned.presenceEffect).toBe("child_result_only_not_new_instructions_intent_or_whole_request_completion");
    expect(returned).not.toHaveProperty("nextAction");
    expect(JSON.stringify(head)).toBe(before);
    expect(projectExecutionChildContinuations(head, call)).toEqual(continuations);
  });

  test("preserves exact stored summary bytes including surrounding whitespace and JSON-looking text", async () => {
    const { head, call, result } = await createReturnedChild();
    const stored = replaceResult(head, { ...result, summary: SUMMARY });
    const message = projectExecutionChildContinuations(stored, call)[0]!.messages[1]!;
    expect(JSON.parse(message.content).result.summary).toBe(SUMMARY);
  });

  test("preserves an existing validated result receipt without synthesizing one", async () => {
    const { head, call, result } = await createReturnedChild("completed", SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT);
    expect(result.receipt).toBeDefined();
    const resultMessage = projectExecutionChildContinuations(head, call)[0]!.messages[1]!;
    expect(JSON.parse(resultMessage.content).result.receipt).toEqual(result.receipt);
  });

  test("leaves legacy children without invocation metadata outside the new timeline", async () => {
    const { head, call, child } = await createReturnedChild();
    const { parentInvocationAttempt: _legacyOrder, ...legacyChild } = child;
    const legacy = { ...head, state: { ...head.state, calls: head.state.calls.map((entry) =>
      entry.callId === child.callId ? legacyChild : entry,
    ) } };
    expect(projectExecutionChildContinuations(legacy, call)).toEqual([]);
    expect(legacy.state.results).toEqual(head.state.results);
  });

  test("does not include another caller's completed child", async () => {
    const { head, call, child, result } = await createReturnedChild();
    const foreignChild = { ...child, callId: "foreign-child", parentCallId: "foreign-caller", resultRef: "foreign-result" };
    const foreignResult = { ...result, resultRef: "foreign-result", producerCallId: "foreign-child", summary: "FOREIGN_SECRET" };
    const augmented = { ...head, state: { ...head.state,
      calls: [...head.state.calls, foreignChild], results: [...head.state.results, foreignResult],
    } };
    const projected = projectExecutionChildContinuations(augmented, call);
    expect(projected).toEqual(projectExecutionChildContinuations(head, call));
    expect(JSON.stringify(projected)).not.toContain("FOREIGN_SECRET");
  });

  test("rejects a direct-child entry bound to a different parent", async () => {
    const { head, call, child } = await createReturnedChild();
    const corrupted = { ...head, state: { ...head.state, calls: head.state.calls.map((entry) =>
      entry.callId === child.callId ? { ...entry, parentCallId: "foreign-caller" } : entry,
    ) } };
    expect(() => projectExecutionChildContinuations(corrupted, call)).toThrow("role_completed_child_projection_invalid");
  });

  test.each([
    ["producer", { producerCallId: "foreign-child" }],
    ["role", { roleId: "reviewer" }],
    ["result reference", { resultRef: "foreign-result" }],
  ] as const)("rejects a mismatched canonical %s", async (_label, patch) => {
    const { head, call, result } = await createReturnedChild();
    const corrupted = replaceResult(head, { ...result, ...patch });
    expect(() => projectExecutionChildContinuations(corrupted, call)).toThrow("role_completed_child_projection_invalid");
  });

  test("rejects a receipt with a foreign child binding", async () => {
    const { head, call, result } = await createReturnedChild("completed", SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT);
    if (result.receipt?.kind !== "work_result_v1") throw new Error("expected_work_receipt");
    const receipt = { ...result.receipt, producerCallId: "foreign-child" };
    expect(() => projectExecutionChildContinuations(replaceResult(head, { ...result, receipt }), call))
      .toThrow("role_completed_child_projection_invalid");
  });

  test.each([0, 1.5, 2])("rejects an invalid or unreturned parent activation %s", async (parentInvocationAttempt) => {
    const { head, call, child } = await createReturnedChild();
    const corrupted = { ...head, state: { ...head.state, calls: head.state.calls.map((entry) =>
      entry.callId === child.callId ? { ...entry, parentInvocationAttempt } : entry,
    ) } };
    expect(() => projectExecutionChildContinuations(corrupted, call)).toThrow("execution_agent_child_continuation_attempt_invalid");
  });

  test("rejects a foreign caller or a stale parent activation", async () => {
    const { head, call } = await createReturnedChild();
    expect(() => projectExecutionChildContinuations(head, { ...call, callId: "foreign-caller" }))
      .toThrow("execution_agent_child_continuation_caller_invalid");
    expect(() => projectExecutionChildContinuations(head, { ...call, activationCount: call.activationCount - 1 }))
      .toThrow("execution_agent_child_continuation_caller_invalid");
  });
});
