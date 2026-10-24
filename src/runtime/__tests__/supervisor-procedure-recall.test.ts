import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { LongTermMemoryRecord } from "../long-term-memory/contracts.js";
import { projectLongTermMemoryMessage } from "../long-term-memory/projection.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildSupervisorDelegationInput } from "../steps/supervisor-decision/delegation-input.js";
import { buildSupervisorProcedureGateInput } from "../steps/supervisor-decision/procedure-gate.js";
import { projectSupervisorProcedureRecall } from "../steps/supervisor-decision/procedure-recall.js";
import { createMemoryRecallHarness, MEMORY_RECORD, RECALL_KIND, RECALL_QUERY } from "./support/memory-recall-runner.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const binding = { requestId: "memory-recall-request", callId: "call-1", steeringVersion: 0 };
const diagnostic = { ...binding, modelStep: "supervisor.decision" as const, invocationAttempt: 2 };
const currentFact = "The user's favorite color is blue.";
const currentRecord = { ...MEMORY_RECORD, content: currentFact };
const initialFact = "OLD_INITIAL_SNAPSHOT";
const initialMemoryMessage = projectLongTermMemoryMessage([{ ...MEMORY_RECORD, content: initialFact }])!;

function recallMessage(records: readonly LongTermMemoryRecord[] = [currentRecord], outcome = "found"): ChatMessage {
  return { role: "system", content: JSON.stringify({
    kind: RECALL_KIND, authority: "passive_reference", ...binding,
    purpose: "answer_the_active_roots_explicit_memory_queries",
    applicability: "only_this_root_request_and_steering_version",
    presenceEffect: "not_user_intent_assignment_action_authority_or_completion_evidence",
    omissionPolicy: "newest_recalls_first_whole_records_newest_occurrence_per_memory_id",
    omittedRecallCount: 0, omittedRecordCount: 0,
    recalls: [{ recallId: "recall-1", invocationAttempt: 1, completedChildCount: 0,
      query: RECALL_QUERY, outcome, memories: records, omittedRecordCount: 0 }],
  }) };
}

test("a rich receipt larger than 1,000 characters yields complete readable facts below the gate cap", () => {
  const record = { ...currentRecord, tags: ["metadata ".repeat(150)] };
  const message = recallMessage([record]);
  expect(message.content.length).toBeGreaterThan(1_000);
  const projected = projectSupervisorProcedureRecall(message, binding);
  expect(projected.message.content).toContain(currentFact);
  expect(projected.message.content.length).toBeLessThanOrEqual(1_000);
  expect(() => JSON.parse(projected.message.content)).toThrow();
  expect(projected.message.content).not.toContain(record.tags[0]!);
  expect(projected.message.content).not.toContain(RECALL_KIND);
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
  const projected = projectSupervisorProcedureRecall(recallMessage([record]), binding);
  expect(projected.message.content).toContain(currentFact);
  expect(projected.message.content).toContain(certainty);
  expect(projected.message.content).toContain(observedAt);
});

test("omits an oversized whole fact and retains later complete facts with an omission count", () => {
  const oversized = { ...currentRecord, id: "large", content: "TOO_LARGE ".repeat(150) };
  const projected = projectSupervisorProcedureRecall(recallMessage([oversized, currentRecord]), binding);
  expect(projected.message.content).not.toContain("TOO_LARGE");
  expect(projected.message.content).toContain(currentFact);
  expect(projected.message.content).toContain("Omitted stored facts: 1.");
  expect(projected.message.content.length).toBeLessThanOrEqual(1_000);
});

test.each(["empty", "unavailable"])("keeps %s distinguishable without inventing memory or adding initial facts", outcome => {
  const projected = projectSupervisorProcedureRecall(recallMessage([], outcome), binding);
  expect(projected.message.content).toContain(outcome);
  expect(projected.message.content).not.toContain(currentFact);
  expect(projected.message.content.length).toBeLessThanOrEqual(1_000);
});

test("uses the latest lookup while preserving omissions from earlier lookups", () => {
  const message = recallMessage();
  const reference = JSON.parse(message.content);
  reference.omittedRecallCount = 1;
  reference.omittedRecordCount = 2;
  reference.recalls.unshift({ ...reference.recalls[0], memories: [{ ...currentRecord, content: "OLDER_LOOKUP" }] });
  const projected = projectSupervisorProcedureRecall({ role: "system", content: JSON.stringify(reference) }, binding);
  expect(projected.message.content).not.toContain("OLDER_LOOKUP");
  expect(projected.message.content).toContain(currentFact);
  expect(projected.message.content).toContain("Omitted lookup results: 2.");
  expect(projected.message.content).toContain("Omitted stored facts: 3.");
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
  const visible = JSON.stringify(input.context.messages);
  expect(visible).toContain(currentFact);
  expect(visible).not.toContain(initialFact);
  expect(visible).not.toContain(RECALL_KIND);
  expect(f.memory.retrieve).not.toHaveBeenCalled();
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
