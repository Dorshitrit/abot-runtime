import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { estimateMessagesTokens } from "../context/token-estimator.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { buildExecutionCapabilityResultMessage, buildExecutionCapabilityResultSource } from "../steps/execution-agent/capability-result-context.js";
import { buildExecutionContinuationMessages } from "../steps/execution-agent/state-context.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import { createExecutionAgentCompactionController } from "../steps/execution-agent/compaction.js";
import { runExecutionAgentDecision } from "../steps/execution-agent/run.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { activeEvidenceCall, createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { readCompactionEnvelope, semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;
const body = "EXACT_RECEIPT ".repeat(200).trim();

async function settle(f: Fixture, summary: string, output = body, generic = false) {
  const call = activeEvidenceCall(f.ledger.current());
  await f.commit({
    authority: "active_role", type: "begin_capability_execution",
    callId: call.callId, invocationAttempt: call.activationCount,
    capabilityId: "evidence.read", declaredEffect: "observation",
    intent: "Read exact evidence.", controlsJson: '{}',
  });
  const execution = f.ledger.current().state.capabilityExecutions.at(-1)!;
  const exactResult = generic ? {
    kind: "generic_capability_result_v1", authority: "capability_adapter",
    status: "executed", ok: true, payload: { output },
  } : {
    kind: "registered_tool_execution_result_v1", authority: "registered_plugin",
    status: "executed", result: {
      ok: true, tool: "evidence.read", output, producedNewInformation: true,
    },
  };
  await f.commit({
    authority: "runtime", type: "settle_capability_execution",
    callId: call.callId, executionId: execution.executionId,
    outcome: "succeeded", observedEffect: "observation", summary, exactResult,
  });
  return f.ledger.current().state.capabilityExecutions.at(-1)!;
}

function inputs(f: Fixture) {
  const head = f.ledger.current();
  const options = {
    head, call: activeEvidenceCall(head), steeringSnapshot: f.steering.snapshot(),
    includeAcknowledgement: false, includeTitle: false,
    allowPlanner: false, allowAuditor: false,
  };
  return {
    options,
    views: [buildExecutionAgentInput(f.request, options), buildExecutionAgentResponseInput(f.request, options)],
  };
}

function resultMessage(messages: readonly ChatMessage[]) {
  const message = messages.find((item) => item.role === "tool");
  if (!message) throw new Error("test_result_missing");
  return message;
}

function controller(f: Fixture, request = f.request) {
  const head = f.ledger.current();
  return createExecutionAgentCompactionController(request, {
    head, call: activeEvidenceCall(head), steeringSnapshot: f.steering.snapshot(),
    consumer: "execution.decision", allowedConsumers: ["execution.decision", "execution.response"],
  });
}

test("decision and response budget one exact copy while canonical source bytes stay unchanged", async () => {
  const f = await createControlsEvidenceFixture();
  const execution = await settle(f, body);
  const head = f.ledger.current();
  const original = JSON.stringify(head);
  const canonical = buildExecutionCapabilityResultMessage(head, execution);
  const continuation = buildExecutionContinuationMessages(head);
  const source = buildExecutionCapabilityResultSource(head, execution);
  expect(source.content).toBe(JSON.stringify(canonical));
  expect(JSON.parse(canonical.content).result.summary).toBe(body);
  for (const input of inputs(f).views) {
    const message = resultMessage(input.messages);
    const result = JSON.parse(message.content).result;
    expect(result).not.toHaveProperty("summary");
    expect(result.adapterResult).toEqual(execution.exactResult);
    expect(result).toMatchObject({
      executionId: execution.executionId, outcome: "succeeded", observedEffect: "observation",
    });
    expect(message.content.split(body)).toHaveLength(2);
    expect(() => validateModelGatewayMessages(input.messages)).not.toThrow();
    expect(input.context.budget.parts.continuationInputTokens).toBe(estimateMessagesTokens(continuation));
    const canonicalContinuation = continuation.map((item) => item === resultMessage(continuation) ? canonical : item);
    expect(input.context.budget.parts.continuationInputTokens).toBeLessThan(estimateMessagesTokens(canonicalContinuation));
  }
  expect(JSON.stringify(head)).toBe(original);
  expect(f.ledger.current()).toBe(head);
});

test.each([
  { label: "independent summary", summary: "Read completed with a coverage caveat.", output: body, generic: false },
  { label: "substring", summary: body.slice(0, 30), output: body, generic: false },
  { label: "whitespace difference", summary: body, output: body + "\n", generic: false },
  { label: "unrelated adapter", summary: body, output: body, generic: true },
])("preserves $label byte-for-byte", async ({ summary, output, generic }) => {
  const f = await createControlsEvidenceFixture();
  const execution = await settle(f, summary, output, generic);
  const canonical = buildExecutionCapabilityResultMessage(f.ledger.current(), execution);
  for (const input of inputs(f).views) expect(resultMessage(input.messages)).toEqual(canonical);
});

test("does not merge separate executions with identical output", async () => {
  const f = await createControlsEvidenceFixture();
  const first = await settle(f, body);
  const second = await settle(f, body);
  const messages = buildExecutionContinuationMessages(f.ledger.current());
  const results = messages.filter(({ role }) => role === "tool");
  expect(results.flatMap((message) => message.role === "tool" ? [message.toolCallId] : [])).toEqual([first.executionId, second.executionId]);
  for (const message of results) expect(message.content.split(body)).toHaveLength(2);
  expect(() => validateModelGatewayMessages(messages)).not.toThrow();
});

test("the actual decision sends the reduced view to provider token counting and dispatch", async () => {
  const f = await createControlsEvidenceFixture();
  await settle(f, body);
  f.invoke.mockResolvedValue({ text: JSON.stringify({ decision: { action: "respond" } }), meta: {} });
  await runExecutionAgentDecision(f.request, inputs(f).options);
  expect(f.countInputTokens).toHaveBeenCalled();
  for (const [input] of [...f.countInputTokens.mock.calls, ...f.invoke.mock.calls]) {
    const message = resultMessage(input.messages as readonly ChatMessage[]);
    expect(message.content.split(body)).toHaveLength(2);
    expect(JSON.parse(message.content).result).not.toHaveProperty("summary");
  }
});

test("compaction and restored checkpoints retain the original source identity without recompact", async () => {
  const compaction = semanticContractFixture({ policy: "execution-agent-v1" });
  const sourceRequest = compaction.params.request;
  const f = await createControlsEvidenceFixture({
    contextCompactionStore: compaction.store,
    modelGatewayClient: sourceRequest.modelGatewayClient,
    runnerConfig: sourceRequest.runnerConfig, modelPolicy: sourceRequest.modelPolicy,
  });
  const execution = await settle(f, body);
  const original = buildExecutionCapabilityResultSource(f.ledger.current(), execution);
  const native = buildExecutionContinuationMessages(f.ledger.current());
  const root = controller(f);
  const prepared = await root.getStages()[0]!.prepare(native);
  if (prepared.kind !== "prepared") throw new Error("test_compaction_missing");
  await prepared.preparation.commit();
  const captured = compaction.captured.flatMap((messages) => readCompactionEnvelope(messages).newSources ?? []);
  expect(captured.find(({ sourceRef }) => sourceRef === original.sourceRef)?.content).toBe(original.content);
  const snapshot = captureRequestContextCompaction(compaction.store);
  expect(snapshot.sources).toContainEqual(original);
  const restored = restoreRequestContextCompaction(snapshot);
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
  const resumed = controller(f, deriveTestRequestExecutionScope(f.request, { contextCompactionStore: restored }));
  expect(resumed.project(native)).toEqual(root.project(native));
  expect(JSON.stringify(resumed.project(native))).not.toContain(body);
  expect(await resumed.getStages()[0]!.prepare(native)).toEqual({ kind: "unavailable", reason: "no_new_sources" });
  expect(snapshot.sources).toContainEqual(original);
});
