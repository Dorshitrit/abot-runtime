import { afterEach, beforeEach, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { scanCompactionSources } from "../context/model-step-compaction-projection.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { createRoleCallLedger, type RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { projectExecutionChildContinuations } from "../steps/execution-agent/child-continuation.js";
import { createExecutionAgentCompactionController } from "../steps/execution-agent/compaction.js";
import { buildExecutionAgentResponseInput } from "../steps/execution-agent/response-input.js";
import {
  buildExecutionContinuationMessages,
  buildExecutionDecisionStateMessage,
  buildExecutionResponseStateMessage,
} from "../steps/execution-agent/state-context.js";
import { createRootCompactionFixture } from "./support/root-compaction-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const CHILD_BODY = "EXACT_CHILD_PROPOSAL: inspect the selected source before changing it.";
const STEERING = { version: 0, updates: [] } as const;
const CONSUMERS = ["execution.decision", "execution.response"] as const;

async function childFixture() {
  const f = await createRootCompactionFixture("execution-agent-v1", { noActiveEvidence: true });
  const ledger = createRoleCallLedger({
    requestId: f.request.requestId, policy: createRequestRoleCallPolicy(f.request.executionPolicy),
  });
  async function commit(command: unknown) {
    const result = await ledger.apply({ expectedHead: ledger.current(), command });
    if (!result.ok) throw new Error(result.code);
  }
  await commit({ authority: "runtime", type: "create_root" });
  await commit({
    authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "planner", objective: "Propose how to implement the requested change.",
  });
  await commit({
    authority: "runtime", type: "return_child", callerCallId: "call-1",
    childCallId: "call-2", outcome: "completed", summary: CHILD_BODY,
  });
  const head = ledger.current();
  const call = head.state.calls[0]!;
  const children = projectExecutionChildContinuations(head, call);
  const messages: ChatMessage[] = [
    { role: "user", content: f.request.prompt },
    buildExecutionDecisionStateMessage(head, call, 0, [], children.map(({ resultRef }) => resultRef)),
    ...buildExecutionContinuationMessages(head, call, [], children),
  ];
  const controller = createExecutionAgentCompactionController(f.request, {
    head, call, steeringSnapshot: STEERING, consumer: "execution.decision", allowedConsumers: CONSUMERS,
  });
  return { ...f, ledger, head, call, children, messages, controller, commit };
}

async function compactChild(f: Awaited<ReturnType<typeof childFixture>>) {
  const stage = f.controller.getStages()[0]!;
  const outcome = await stage.prepare(f.messages);
  if (outcome.kind !== "prepared") throw new Error("expected_prepared_child_compaction");
  await outcome.preparation.commit();
  return outcome.preparation;
}

test("native child action and result compact together and remain paired after snapshot roundtrip", async () => {
  const f = await childFixture();
  expect(f.children).toHaveLength(1);
  expect(() => validateModelGatewayMessages(f.messages)).not.toThrow();
  const before = scanCompactionSources(f.messages, "unused", new Map());
  expect(before).toHaveLength(2);
  expect(before.map(({ source }) => source.sourceRef)).toContain("tool-result:role-call:call-2");
  expect(before.some(({ source }) => source.sourceRef.startsWith("tool-action:"))).toBe(true);
  const prepared = await compactChild(f);
  expect(prepared.coveredSourceCount).toBe(2);
  expect(prepared.hasExhaustedCompactionSources).toBe(true);
  expect(prepared.messages.some(({ role }) => role === "tool")).toBe(false);
  expect(prepared.messages.some((message) => message.role === "assistant" && message.toolCalls)).toBe(false);
  expect(JSON.stringify(prepared.messages)).not.toContain(CHILD_BODY);
  expect(() => validateModelGatewayMessages(prepared.messages)).not.toThrow();
  const snapshot = captureRequestContextCompaction(f.request.contextCompactionStore!);
  expect(snapshot.sources).toHaveLength(2);
  expect(snapshot.checkpoints[0]!.sourceDigests).toHaveLength(2);
  const serialized = JSON.stringify(snapshot);
  const restored = restoreRequestContextCompaction(JSON.parse(serialized));
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
  const controller = createExecutionAgentCompactionController(
    deriveTestRequestExecutionScope(f.request, { contextCompactionStore: restored }),
    { head: f.head, call: f.call, steeringSnapshot: STEERING, consumer: "execution.decision", allowedConsumers: CONSUMERS },
  );
  expect(controller.project(f.messages)).toEqual(prepared.messages);
  expect(JSON.stringify(snapshot)).toBe(serialized);
});

test("regenerated child source identities are stable and changed bytes cannot reuse the covered identity", async () => {
  const f = await childFixture();
  await compactChild(f);
  const scanned = scanCompactionSources(f.messages, "unused", new Map());
  const regenerated = projectExecutionChildContinuations(f.head, f.call).flatMap(({ messages }) => messages);
  expect(scanCompactionSources(regenerated, "unused", new Map()).map(({ source }) => source)).toEqual(
    scanned.map(({ source }) => source),
  );
  const changed = f.messages.map((message): ChatMessage => message.role === "tool"
    ? { ...message, content: message.content.replace(CHILD_BODY, "Changed unbound proposal.") }
    : message);
  await expect(f.controller.getStages()[0]!.prepare(changed)).rejects.toThrow("context_compaction_source_identity_conflict");
});

test("legacy child frames retain original state evidence and introduce no native compaction source", async () => {
  const f = await childFixture();
  const legacy = structuredClone(f.head);
  for (const call of legacy.state.calls) delete (call as { parentInvocationAttempt?: number }).parentInvocationAttempt;
  const head = legacy as RoleCallLedgerHead;
  const call = head.state.calls[0]!;
  const children = projectExecutionChildContinuations(head, call);
  expect(children).toEqual([]);
  const messages = [
    buildExecutionDecisionStateMessage(head, call, 0, [], []),
    ...buildExecutionContinuationMessages(head, call, [], children),
  ];
  expect(JSON.parse(messages[0]!.content).completedSubordinateResults[0].summary).toBe(CHILD_BODY);
  expect(scanCompactionSources(messages, "unused", new Map())).toEqual([]);
  expect(() => validateModelGatewayMessages(messages)).not.toThrow();
});

test("parked approval roundtrip preserves role source bytes and legacy child metadata remains optional", async () => {
  const f = await childFixture();
  await compactChild(f);
  await f.commit({
    authority: "active_role", type: "begin_capability_execution", callId: "call-1",
    invocationAttempt: f.call.activationCount, capabilityId: "evidence.change",
    declaredEffect: "mutation", intent: "Wait for approved change.", controlsJson: "{}",
  });
  const ledgerCheckpoint = captureRoleCallLedgerCheckpoint(f.ledger);
  const snapshot = captureRequestContextCompaction(f.request.contextCompactionStore!);
  const restored = restoreApprovalCompaction({
    snapshot: JSON.parse(JSON.stringify(snapshot)), ledgerCheckpoint,
    requestId: f.request.requestId, prompt: f.request.prompt, executionPolicy: f.request.executionPolicy,
  });
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
  const legacy = structuredClone(ledgerCheckpoint);
  for (const call of legacy.state.calls) delete (call as { parentInvocationAttempt?: number }).parentInvocationAttempt;
  const ledger = createRoleCallLedger({
    requestId: f.request.requestId, policy: createRequestRoleCallPolicy(f.request.executionPolicy), checkpoint: legacy,
  });
  const settled = await ledger.apply({ expectedHead: ledger.current(), command: {
    authority: "runtime", type: "settle_capability_execution", callId: "call-1",
    executionId: "capability-execution-1", outcome: "succeeded", observedEffect: "mutation",
    summary: "Approved change settled.", exactResult: {
      kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed",
      ok: true, payload: "Approved change settled.",
    },
  } });
  if (!settled.ok) throw new Error(settled.code);
  const head = ledger.current();
  expect(projectExecutionChildContinuations(head, head.state.calls[0]!)).toEqual([]);
  expect(JSON.parse(buildExecutionResponseStateMessage(head, head.state.calls[0]!).content)
    .completedSubordinateResults[0].summary).toBe(CHILD_BODY);
});

test("response builder reuses native child sources once and shared compaction removes both halves", async () => {
  const f = await childFixture();
  await compactChild(f);
  const response = buildExecutionAgentResponseInput(f.request, {
    head: f.head, call: f.call, steeringSnapshot: STEERING,
  });
  const state = response.messages.find(({ content }) => content.includes('"kind":"runtime_execution_state_v1"'))!;
  const result = JSON.parse(state.content).completedSubordinateResults[0];
  expect(result).toMatchObject({ resultRef: "result-1", roleId: "planner", outcome: "completed" });
  expect(result).not.toHaveProperty("summary");
  expect(response.messages.filter(({ content }) => content.includes(CHILD_BODY))).toHaveLength(1);
  expect(response.messages.filter((message) => message.role === "tool" && message.toolName === "runtime_role")).toHaveLength(1);
  const sources = scanCompactionSources(response.messages, "unused", new Map()).map(({ source }) => source);
  expect(sources).toEqual(scanCompactionSources(f.messages, "unused", new Map()).map(({ source }) => source));
  expect(() => validateModelGatewayMessages(response.messages)).not.toThrow();
  const controller = createExecutionAgentCompactionController(f.request, {
    head: f.head, call: f.call, steeringSnapshot: STEERING, consumer: "execution.response", allowedConsumers: CONSUMERS,
  });
  const projected = controller.project(response.messages);
  expect(projected).toContain(state);
  expect(JSON.stringify(projected)).not.toContain(CHILD_BODY);
  expect(projected.some(({ role }) => role === "tool")).toBe(false);
  expect(projected.some((message) => message.role === "assistant" && message.toolCalls)).toBe(false);
  const checkpoints = projected.filter(({ content }) => content.includes('"coveredSources"'));
  expect(checkpoints).toHaveLength(1);
  const covered = JSON.parse(checkpoints[0]!.content).coveredSources;
  expect(covered).toHaveLength(2);
  expect(new Set(covered.map(({ sourceRef }: { sourceRef: string }) => sourceRef)).size).toBe(2);
  expect(() => validateModelGatewayMessages(projected)).not.toThrow();
});
