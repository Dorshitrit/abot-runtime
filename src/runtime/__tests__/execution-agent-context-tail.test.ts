import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { runExecutionAgentDecision } from "../steps/execution-agent/run.js";
import { buildExecutionContinuationMessages } from "../steps/execution-agent/state-context.js";
import { activeEvidenceCall, createControlsEvidenceFixture, runtimeCapsule } from "./support/execution-controls-evidence-fixture.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";

type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;

function options(fixture: Fixture) {
  const head = fixture.ledger.current();
  return {
    head, call: activeEvidenceCall(head), steeringSnapshot: fixture.steering.snapshot(),
    includeAcknowledgement: false, includeTitle: false, allowPlanner: true, allowAuditor: true,
  };
}

function native(messages: readonly ChatMessage[]) {
  return messages.filter((message) => message.role === "tool" ||
    (message.role === "assistant" && message.toolCalls !== undefined));
}

async function addBatch(fixture: Fixture) {
  const call = activeEvidenceCall(fixture.ledger.current());
  const priorCount = fixture.ledger.current().state.capabilityExecutions.length;
  await fixture.commit({
    authority: "active_role", type: "begin_capability_batch", callId: call.callId,
    invocationAttempt: call.activationCount,
    entries: ["a", "b"].map((target) => ({
      capabilityId: "evidence.read", declaredEffect: "observation", intent: "Read exact target.",
      controlsJson: JSON.stringify({ path: `${target}.txt`, query: "Read exact target." }),
      actionFingerprint: `sha256:${target.repeat(64)}`,
    })),
  });
  const executions = fixture.ledger.current().state.capabilityExecutions.slice(priorCount);
  await fixture.commit({
    authority: "runtime", type: "settle_capability_batch", callId: call.callId,
    settlements: executions.map((execution, index) => ({
      executionId: execution.executionId,
      outcome: index === 0 ? "failed" : "succeeded",
      observedEffect: index === 0 ? "none" : "observation",
      outcomeFingerprint: index === 0 ? `sha256:${"c".repeat(64)}` : "succeeded",
      summary: index === 0 ? "The file changed. Read it again." : "Second sibling completed.",
      exactResult: {
        kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed",
        ok: index !== 0, payload: index === 0 ? "EXACT_STALE_RANGE_FAILURE" : "EXACT_SUCCESSFUL_SIBLING",
      },
    })),
  });
  return executions.map(({ executionId }) => executionId);
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("moves the latest mixed-outcome batch as one native group after all ordinary activation context", async () => {
  const f = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
  await f.addResult("OLDER_EXACT_RESULT");
  const executionIds = await addBatch(f);
  const input = buildExecutionAgentInput(f.request, options(f));
  const chronological = buildExecutionContinuationMessages(f.ledger.current(), activeEvidenceCall(f.ledger.current()));
  const latest = chronological.slice(-3);
  expect(input.messages.slice(-3)).toEqual(latest);
  expect(latest[0]).toMatchObject({ role: "assistant", toolCalls: executionIds.map((callId) => ({ callId })) });
  expect(latest.slice(1).map((message) => message.role === "tool" && message.toolCallId)).toEqual(executionIds);
  expect(native(input.messages)).toEqual(chronological);
  const boundary = input.messages.indexOf(input.promptCacheBoundaryBeforeMessage!);
  expect(native(input.messages.slice(0, boundary))).toEqual(chronological.slice(0, -3));
  expect(native(input.messages.slice(boundary))).toEqual(latest);
  expect(input.messages.slice(0, -3).some(({ content }) => content.includes('"kind":"runtime_execution_state_v1"'))).toBe(true);
  expect(JSON.stringify(latest)).toContain("EXACT_STALE_RANGE_FAILURE");
  expect(JSON.stringify(latest)).toContain("EXACT_SUCCESSFUL_SIBLING");
  expect(input.context.messages).toEqual(input.messages);
  validateModelGatewayMessages(input.messages);
});

test("keeps current supervision after every sibling and later user steering after supervision", async () => {
  const f = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
  await addBatch(f);
  const executionIds = await addBatch(f);
  f.steering.append({ steerId: "stop-after-failure", text: "Stop making changes and explain the failed action." });
  const input = buildExecutionAgentInput(f.request, options(f));
  const latestResultIndex = input.messages.map(({ role }) => role).lastIndexOf("tool");
  const supervisionIndex = input.messages.findIndex(({ content }) => content.includes('"kind":"runtime_operation_supervision_evidence_v1"'));
  expect(supervisionIndex).toBeGreaterThan(latestResultIndex);
  const supervision = runtimeCapsule(input.messages, "runtime_operation_supervision_evidence_v1")!;
  expect(supervision).toMatchObject({ binding: {
    callId: "call-1", invocationAttempt: activeEvidenceCall(f.ledger.current()).activationCount,
  } });
  expect(JSON.stringify(supervision)).toContain(executionIds[0]);
  expect(input.messages[supervisionIndex]?.role).toBe("user");
  expect(input.messages.at(-1)).toMatchObject({ role: "user" });
  expect(input.messages.at(-1)?.content).toContain("Stop making changes and explain the failed action.");
  expect(input.context.messages.at(-1)?.content).toContain('"kind":"runtime_operation_supervision_evidence_v1"');
  validateModelGatewayMessages(input.messages);
});

test("actual EA structured repair retains the exact native tail, supervision and steering before its fresh hint", async () => {
  const f = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
  await addBatch(f);
  await addBatch(f);
  f.steering.append({ steerId: "report-only", text: "Report only the observed failures." });
  f.invoke.mockResolvedValueOnce({ text: JSON.stringify({ decision: { action: "invalid_action" } }), meta: {} });
  f.invoke.mockResolvedValueOnce({ text: JSON.stringify({ decision: { action: "respond" } }), meta: {} });
  const head = f.ledger.current();
  await runExecutionAgentDecision(f.request, options(f));
  const invocations = f.invoke.mock.calls.filter(([input]) => input.modelStep === "execution.decision").map(([input]) => input);
  expect(invocations).toHaveLength(2);
  const initial = invocations[0]!, repaired = invocations[1]!;
  const initialMessages = initial.messages as ChatMessage[];
  const repairedMessages = repaired.messages as ChatMessage[];
  expect(repairedMessages).toHaveLength(initialMessages.length + 1);
  expect(repairedMessages.slice(0, -2)).toEqual(initialMessages.slice(0, -1));
  expect(repairedMessages.at(-2)).toMatchObject({ role: "system" });
  expect(repairedMessages.at(-2)?.content.length).toBeGreaterThan(0);
  for (const messages of [initialMessages, repairedMessages]) {
    expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({ kind: "runtime_invocation_time_v1" });
    expect(messages.filter(({ content }) => content.includes('"kind":"runtime_invocation_time_v1"'))).toHaveLength(1);
  }
  expect(initialMessages.at(-2)?.content).toContain("Report only the observed failures.");
  expect(native(repairedMessages)).toEqual(native(initialMessages));
  expect(repaired.format).toEqual(initial.format);
  expect(repaired.promptCacheScope).toBe(initial.promptCacheScope);
  expect(repaired.promptCacheBoundaryBeforeMessageIndex).toBe(initial.promptCacheBoundaryBeforeMessageIndex);
  const counted = f.countInputTokens.mock.calls.filter(([input]) => input.modelStep === "execution.decision").at(-1)![0];
  expect(counted.messages).toEqual(repairedMessages);
  expect(counted.promptCacheBoundaryBeforeMessageIndex).toBe(repaired.promptCacheBoundaryBeforeMessageIndex);
  expect(f.ledger.current()).toBe(head);
  validateModelGatewayMessages(repairedMessages);
});
