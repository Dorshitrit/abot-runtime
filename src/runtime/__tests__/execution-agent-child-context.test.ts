import { afterEach, beforeEach, expect, test } from "vitest";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import { buildExecutionContinuationMessages } from "../steps/execution-agent/state-context.js";
import { projectExecutionChildContinuations } from "../steps/execution-agent/child-continuation.js";
import { activeEvidenceCall, createControlsEvidenceFixture, runtimeCapsule } from "./support/execution-controls-evidence-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());
type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;

async function returnChild(fixture: Fixture, summary: string, outcome: "completed" | "failed" = "completed") {
  const opened = await fixture.ledger.transactions!.openChild({
    expectedHead: fixture.ledger.current(), callerCallId: "call-1",
    roleId: "planner", objective: "Plan the bounded operation from the observed source.",
  });
  if (!opened.ok) throw new Error(opened.issueCode);
  const childCallId = opened.commit.effect.childCallId;
  const returned = await fixture.ledger.transactions!.returnChild({
    expectedHead: fixture.ledger.current(), callerCallId: "call-1", childCallId,
    outcome, summary,
  });
  if (!returned.ok) throw new Error(returned.issueCode);
  return childCallId;
}

function inputs(fixture: Fixture, head = fixture.ledger.current()) {
  const options = { head, call: activeEvidenceCall(head), steeringSnapshot: fixture.steering.snapshot() };
  return {
    decision: buildExecutionAgentInput(fixture.request, {
      ...options, includeAcknowledgement: false, includeTitle: false,
      allowPlanner: true, allowAuditor: false,
    }),
    response: buildExecutionAgentResponseInput(fixture.request, options),
  };
}

function toolIds(messages: readonly ChatMessage[]) {
  return messages.flatMap((message) => message.role === "assistant"
    ? message.toolCalls?.map(({ callId }) => callId) ?? [] : []);
}

function withoutChildOrdering(head: RoleCallLedgerHead): RoleCallLedgerHead {
  return { ...head, state: { ...head.state, calls: head.state.calls.map((call) => {
    const { parentInvocationAttempt: _position, ...legacy } = call;
    return legacy;
  }) } };
}

test("decision carries child results once after the request in accepted capability/child order", async () => {
  const fixture = await createControlsEvidenceFixture();
  const firstExecution = await fixture.addResult("Observed exact initial facts.");
  const firstChild = await returnChild(fixture, "EXACT_PLANNER_RETURN_ONE");
  const secondExecution = await fixture.addResult("Observed changed facts.");
  const secondChild = await returnChild(fixture, "EXACT_FAILED_RETURN_TWO", "failed");
  const { decision, response } = inputs(fixture);
  expect(() => validateModelGatewayMessages(decision.messages)).not.toThrow();
  expect(toolIds(decision.messages)).toEqual([
    firstExecution, `role-call:${firstChild}`, secondExecution, `role-call:${secondChild}`,
  ]);
  const requestIndex = decision.messages.findIndex(({ content }) => content === fixture.request.prompt);
  expect(decision.messages.filter(({ role, content }) => role === "user" && content === fixture.request.prompt)).toHaveLength(1);
  expect(decision.messages.findIndex((message) => message.role === "tool" && message.toolName === "runtime_role")).toBeGreaterThan(requestIndex);
  const state = runtimeCapsule(decision.messages, "runtime_execution_state_v1")!;
  expect(state.completedSubordinateResults).toEqual([
    { resultRef: "result-1", roleId: "planner", outcome: "completed", evidenceLane: "chronological_native_role_result" },
    { resultRef: "result-2", roleId: "planner", outcome: "failed", evidenceLane: "chronological_native_role_result" },
  ]);
  const text = JSON.stringify(decision.messages);
  expect(text.split("EXACT_PLANNER_RETURN_ONE")).toHaveLength(2);
  expect(text.split("EXACT_FAILED_RETURN_TWO")).toHaveLength(2);
  // Both EA consumers use identical evidence bytes, so a shared checkpoint has one owner per source.
  expect(toolIds(response.messages)).toEqual(toolIds(decision.messages));
  expect(runtimeCapsule(response.messages, "runtime_execution_state_v1")!.completedSubordinateResults)
    .toEqual(state.completedSubordinateResults);
  const roleEvidence = (messages: readonly ChatMessage[]) => messages.filter((message) =>
    message.role === "tool" && message.toolName === "runtime_role");
  expect(roleEvidence(response.messages)).toEqual(roleEvidence(decision.messages));
  expect(JSON.stringify(response.messages).split("EXACT_PLANNER_RETURN_ONE")).toHaveLength(2);
});

test("legacy snapshots keep full advice in their original lane without guessed chronology", async () => {
  const fixture = await createControlsEvidenceFixture();
  const execution = await fixture.addResult("Observed facts.");
  await returnChild(fixture, "LEGACY_EXACT_ADVICE");
  const legacy = withoutChildOrdering(fixture.ledger.current());
  const { decision } = inputs(fixture, legacy);
  expect(toolIds(decision.messages)).toEqual([execution]);
  expect(runtimeCapsule(decision.messages, "runtime_execution_state_v1")!.completedSubordinateResults).toEqual([
    { resultRef: "result-1", roleId: "planner", outcome: "completed", summary: "LEGACY_EXACT_ADVICE" },
  ]);
});

test("unrelated capability-only continuations keep exactly their existing native bytes", async () => {
  const fixture = await createControlsEvidenceFixture();
  await fixture.addResult("Exact capability output, including whitespace.  ");
  const head = fixture.ledger.current();
  const call = activeEvidenceCall(head);
  const original = buildExecutionContinuationMessages(head, call);
  const children = projectExecutionChildContinuations(head, call);
  expect(children).toEqual([]);
  expect(buildExecutionContinuationMessages(head, call, [], children)).toEqual(original);
  expect(inputs(fixture).decision.messages.slice(-original.length)).toEqual(original);
});

test("recall continuations remain ordered between role and capability interactions", async () => {
  const fixture = await createControlsEvidenceFixture();
  const firstExecution = await fixture.addResult("Before planning.");
  const childId = await returnChild(fixture, "Bounded plan.");
  const head = fixture.ledger.current();
  const call = activeEvidenceCall(head);
  const recall = {
    invocationAttempt: call.activationCount,
    completedChildCount: 1,
    messages: [{ role: "user" as const, content: "BOUNDED_RECALL_EVIDENCE" }],
  };
  const messages = buildExecutionContinuationMessages(head, call, [recall], projectExecutionChildContinuations(head, call));
  expect(toolIds(messages)).toEqual([firstExecution, `role-call:${childId}`]);
  expect(messages.at(-1)).toEqual(recall.messages[0]);
});
