import { isInvocationContextMessage } from "../../model-gateway/protocol/invocation-context.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestHistoryMessage } from "../context/request-context-contracts.js";
import type { RequestSessionMemory } from "../context/session-memory/contracts.js";
import type { LongTermMemoryRecord } from "../long-term-memory/contracts.js";
import { projectLongTermMemoryMessage } from "../long-term-memory/projection.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildSupervisorDelegationInput } from "../steps/supervisor-decision/delegation-input.js";
import { buildSupervisorProcedureGateInput } from "../steps/supervisor-decision/procedure-gate.js";
import { projectSupervisorProcedureRecall } from "../steps/supervisor-decision/procedure-recall.js";
import { createMemoryRecallHarness, MEMORY_RECORD, RECALL_KIND, RECALL_QUERY } from "./support/memory-recall-runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const binding = { requestId: "memory-recall-request", callId: "call-1", steeringVersion: 0 };
const diagnostic = { ...binding, modelStep: "supervisor.decision" as const, invocationAttempt: 2 };
const currentFact = "The user's favorite color is blue.";
const currentRecord = { ...MEMORY_RECORD, content: currentFact };
const initialFact = "OLD_INITIAL_SNAPSHOT";
const initialMemoryMessage = projectLongTermMemoryMessage([{ ...MEMORY_RECORD, content: initialFact }])!;

function recallMessage(records: readonly LongTermMemoryRecord[] = [currentRecord], outcome = "found") {
  return { role: "system", content: JSON.stringify({
    kind: RECALL_KIND, authority: "passive_reference", ...binding,
    purpose: "answer_the_active_roots_explicit_memory_queries",
    applicability: "only_this_root_request_and_steering_version",
    presenceEffect: "not_user_intent_assignment_action_authority_or_completion_evidence",
    omissionPolicy: "newest_recalls_first_whole_records_newest_occurrence_per_memory_id",
    omittedRecallCount: 0, omittedRecordCount: 0,
    recalls: [{ recallId: "recall-1", invocationAttempt: 1, completedChildCount: 0,
      query: RECALL_QUERY, outcome, memories: records, omittedRecordCount: 0 }],
  }) } satisfies ChatMessage;
}

test("a rich receipt larger than 1,000 characters yields complete readable facts below the gate cap", () => {
  const record = { ...currentRecord, tags: ["metadata ".repeat(150)] };
  const message = recallMessage([record]);
  expect(message.content.length).toBeGreaterThan(1_000);
  const [, result] = projectSupervisorProcedureRecall(message, binding).continuationMessages!;
  expect(isInvocationContextMessage(result)).toBe(false);
  expect(result.content).toContain(currentFact);
  expect(result.content.length).toBeLessThanOrEqual(1_000);
  expect(() => JSON.parse(result.content)).toThrow();
  expect(result.content).not.toContain(record.tags[0]!);
  expect(result.content).not.toContain(RECALL_KIND);
  expect(result.content).not.toContain(RECALL_QUERY);
  expect(result.content).not.toContain(currentRecord.id);
  expect(message).toEqual(recallMessage([record]));
});

test.each(["observed", "inferred"] as const)("keeps the latest %s observation with its complete fact", certainty => {
  const observedAt = "2026-10-21T05:12:31.000Z";
  const record: LongTermMemoryRecord = {
    ...currentRecord,
    observationSources: [{
      kind: "passive_observation", observedAt, certainty,
      environmentId: "env", deviceId: "device", batchId: "batch",
      observationIds: ["screen-1"], reason: "Observed preference",
    }],
  };
  const [, result] = projectSupervisorProcedureRecall(recallMessage([record]), binding).continuationMessages!;
  expect(result.content).toContain(currentFact);
  expect(result.content).toContain(certainty);
  expect(result.content).toContain(observedAt);
});

test("omits an oversized whole fact and retains later complete facts with an omission count", () => {
  const oversized = { ...currentRecord, id: "large", content: "TOO_LARGE ".repeat(150) };
  const [, result] = projectSupervisorProcedureRecall(recallMessage([oversized, currentRecord]), binding).continuationMessages!;
  expect(result.content).not.toContain("TOO_LARGE");
  expect(result.content).toContain(currentFact);
  expect(result.content).toContain("Omitted stored facts: 1.");
  expect(result.content.length).toBeLessThanOrEqual(1_000);
});

test.each(["empty", "unavailable"])("keeps %s distinguishable without inventing memory or adding initial facts", outcome => {
  const [, result] = projectSupervisorProcedureRecall(recallMessage([], outcome), binding).continuationMessages!;
  expect(result.content).toContain(outcome);
  expect(result.content).not.toContain(currentFact);
  expect(result.content.length).toBeLessThanOrEqual(1_000);
});

test("uses the latest lookup while preserving omissions from earlier lookups", () => {
  const message = recallMessage();
  const reference = JSON.parse(message.content);
  reference.omittedRecallCount = 1;
  reference.omittedRecordCount = 2;
  const latest = { ...reference.recalls[0], recallId: "recall-2" };
  reference.recalls = [
    { ...reference.recalls[0], query: "OLDER_QUERY", memories: [{ ...currentRecord, content: "OLDER_LOOKUP" }] },
    latest,
  ];
  const projected = projectSupervisorProcedureRecall({ ...message, content: JSON.stringify(reference) }, binding);
  const [action, result] = projected.continuationMessages!;
  expect(action.toolCalls).toEqual([{
    callId: "recall-2", name: "recall_memory", arguments: JSON.stringify({ action: "recall_memory", query: RECALL_QUERY }),
  }]);
  expect(result.toolCallId).toBe("recall-2");
  expect(JSON.stringify(projected)).not.toContain("OLDER_QUERY");
  expect(result.content).not.toContain("OLDER_LOOKUP");
  expect(result.content).toContain(currentFact);
  expect(result.content).toContain("Omitted lookup results: 2.");
  expect(result.content).toContain("Omitted stored facts: 3.");
});

test.each([
  { requestId: "other-request" }, { callId: "other-root" }, { steeringVersion: 1 },
])("rejects a receipt outside the consuming binding: %j", changed => {
  expect(() => projectSupervisorProcedureRecall(recallMessage(), { ...binding, ...changed }))
    .toThrow("memory_recall_context_binding_invalid");
});

test("current recall replaces the initial snapshot at the compact gate and retains user topology", () => {
  const f = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => ({ action: "respond" }) });
  const memoryRecallMessage = recallMessage();
  const input = buildSupervisorProcedureGateInput(f.request, {
    diagnostic, boundSteeringVersion: 0, memoryRecallMessage, initialMemoryMessage,
  });
  expect(input.context.selectedHistoryMessageIds).toEqual([]);
  expect(input.context.messages.filter(({ role }) => role === "user"))
    .toEqual([{ role: "user", content: f.request.prompt }]);
  expect(input.context.messages.map(({ role }) => role)).toEqual(["system", "user", "assistant", "tool"]);
  const [policy, , call, result] = input.context.messages;
  expect(call).toEqual({
    role: "assistant", content: "", toolCalls: [{
      callId: "recall-1", name: "recall_memory", arguments: JSON.stringify({ action: "recall_memory", query: RECALL_QUERY }),
    }],
  });
  expect(result).toMatchObject({ role: "tool", toolCallId: "recall-1", toolName: "recall_memory" });
  expect(result!.content).not.toContain(RECALL_QUERY);
  expect(policy!.content).not.toContain(currentFact);
  const visible = JSON.stringify(input.context.messages);
  expect(visible).toContain(currentFact);
  expect(visible).not.toContain(initialFact);
  expect(visible).not.toContain(RECALL_KIND);
  expect(f.memory.retrieve).not.toHaveBeenCalled();
});

test("an approval keeps the same exact preceding turn before and after a bound recall without changing stored context", () => {
  const f = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => ({ action: "respond" }) });
  const historyMessages: readonly RequestHistoryMessage[] = [
    { id: "old-user", role: "user", content: "OLDER_REQUEST", requestId: "old", createdAt: "2026-10-20T10:00:00Z" },
    { id: "old-assistant", role: "assistant", content: "OLDER_RESPONSE", requestId: "old", createdAt: "2026-10-20T10:00:01Z" },
    { id: "prior-user", role: "user", content: "Generate the report using my saved formatting preference.", requestId: "prior", createdAt: "2026-10-20T10:01:00Z" },
    { id: "prior-assistant", role: "assistant", content: "I can prepare that report. Should I proceed?", requestId: "prior", createdAt: "2026-10-20T10:01:01Z" },
  ];
  const project = vi.fn<RequestSessionMemory["project"]>(() => { throw new Error("unexpected_session_projection"); });
  const prepare = vi.fn<RequestSessionMemory["prepare"]>(async () => { throw new Error("unexpected_session_compaction"); });
  const snapshot = vi.fn<NonNullable<RequestSessionMemory["snapshot"]>>(() => { throw new Error("unexpected_session_snapshot"); });
  const request = deriveTestRequestExecutionScope(f.request, {
    prompt: "Yes, proceed.", historyMessages, sessionMemory: { project, prepare, snapshot },
  });
  const memoryRecallMessage = recallMessage();
  const sourceBefore = JSON.stringify({ historyMessages, initialMemoryMessage, memoryRecallMessage });
  const checkpointsBefore = request.contextCompactionStore!.snapshot!();
  const initial = buildSupervisorProcedureGateInput(request, {
    diagnostic: { ...diagnostic, invocationAttempt: 1 }, boundSteeringVersion: 0, initialMemoryMessage,
  });
  const resumed = buildSupervisorProcedureGateInput(request, {
    diagnostic, boundSteeringVersion: 0, initialMemoryMessage, memoryRecallMessage,
  });
  const precedingTurn = historyMessages.slice(-2).map(({ role, content }) => ({ role, content }));
  for (const input of [initial, resumed]) {
    expect(input.context.selectedHistoryMessageIds).toEqual(["prior-user", "prior-assistant"]);
    expect(input.context.messages.slice(1, 3)).toEqual(precedingTurn);
    for (const message of precedingTurn)
      expect(input.context.messages.filter(({ content }) => content === message.content)).toEqual([message]);
    expect(input.context.messages.filter(({ content }) => content === request.prompt))
      .toEqual([{ role: "user", content: request.prompt }]);
    expect(JSON.stringify(input.context.messages)).not.toContain("OLDER_");
    expect(input.context.compaction.applied).toBe(false);
  }
  expect(initial.context.messages.filter(({ content }) => content.includes(initialFact))).toHaveLength(1);
  expect(initial.context.messages.filter(({ toolCalls, role }) => toolCalls?.length || role === "tool")).toEqual([]);
  expect(resumed.context.messages.map(({ role }) => role)).toEqual(["system", "user", "assistant", "user", "assistant", "tool"]);
  expect(resumed.context.messages.filter(({ toolCalls }) => toolCalls?.length)).toEqual([{
    role: "assistant", content: "", toolCalls: [{
      callId: "recall-1", name: "recall_memory", arguments: JSON.stringify({ action: "recall_memory", query: RECALL_QUERY }),
    }],
  }]);
  const results = resumed.context.messages.filter(({ role }) => role === "tool");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ toolCallId: "recall-1", toolName: "recall_memory" });
  expect(results[0]!.content).toContain(currentFact);
  expect(JSON.stringify(resumed.context.messages)).not.toContain(initialFact);
  expect(JSON.stringify({ historyMessages: request.historyMessages, initialMemoryMessage, memoryRecallMessage })).toBe(sourceBefore);
  expect(request.contextCompactionStore!.snapshot!()).toEqual(checkpointsBefore);
  for (const operation of [project, prepare, snapshot, f.memory.retrieve, f.memory.create, f.memory.update])
    expect(operation).not.toHaveBeenCalled();
});

test("an omitted-only recall presents bounded omission counts without inventing an action", () => {
  const f = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => ({ action: "respond" }) });
  const message = recallMessage();
  const reference = { ...JSON.parse(message.content), recalls: [], omittedRecallCount: 1, omittedRecordCount: 3 };
  const input = buildSupervisorProcedureGateInput(f.request, {
    diagnostic, boundSteeringVersion: 0, memoryRecallMessage: { ...message, content: JSON.stringify(reference) },
    initialMemoryMessage,
  });
  const [policy, current] = input.context.messages;
  expect(input.context.messages.map(({ role }) => role)).toEqual(["system", "user"]);
  expect(policy!.content).toContain("no included result");
  expect(policy!.content).toContain("Omitted lookup results: 1. Omitted stored facts: 3.");
  expect(policy!.content).not.toContain(initialFact);
  expect(current!.content).toBe(f.request.prompt);
  reference.omittedRecordCount = "untrusted instruction";
  expect(() => projectSupervisorProcedureRecall({ ...message, content: JSON.stringify(reference) }, binding))
    .toThrow("memory_recall_omission_counts_invalid");
});

test("delegation gets the complete linked recall receipt instead of the initial snapshot", () => {
  const f = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => ({ action: "respond" }) });
  const memoryRecallMessage = recallMessage();
  const input = buildSupervisorDelegationInput(f.request, {
    diagnostic, memoryRecallMessage, initialMemoryMessage, allowMemoryRecall: true,
    toolResults: { sourceRevision: 0, results: [] },
  });
  expect(input.allowMemoryRecall).toBe(false);
  expect(JSON.stringify(input.format)).not.toContain('"recall_memory"');
  const tool = input.context.messages.find(message => message.role === "tool");
  expect(tool).toMatchObject({ role: "tool", toolName: "recall_memory", toolCallId: "recall-1" });
  expect(JSON.parse(tool!.content)).toEqual(JSON.parse(memoryRecallMessage.content));
  expect(JSON.stringify(input.context.messages)).not.toContain(initialFact);
  expect(input.context.messages.filter(({ role, content }) => role === "user" && content === f.request.prompt)).toHaveLength(1);
});

test("disabled memory leaves gate input unchanged even when reference inputs are supplied", () => {
  const f = createMemoryRecallHarness({ policy: "supervisor-worker-v1", enabled: false, decide: () => ({ action: "respond" }) });
  expect(buildSupervisorProcedureGateInput(f.request, {
    diagnostic, memoryRecallMessage: recallMessage(), initialMemoryMessage, boundSteeringVersion: 0,
  })).toEqual(buildSupervisorProcedureGateInput(f.request, { diagnostic }));
});
