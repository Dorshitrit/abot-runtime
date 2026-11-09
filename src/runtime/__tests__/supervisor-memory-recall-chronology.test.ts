import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { createMemoryRecallHarness, MEMORY_RECORD } from "./support/memory-recall-runner.js";
import { buildSupervisorResponseInput, buildSupervisorMemoryAuthoringInput } from "../steps/supervisor-response/input.js";
import { projectRequestContext } from "../context/request-context.js";
import { buildSupervisorMemoryRecallContinuationParts } from "../steps/supervisor-decision/memory-recall-continuation.js";
import type { SupervisorResumeContext } from "../steps/supervisor-decision/contracts.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function resume(): SupervisorResumeContext {
  return {
    callerCallId: "call-1", invocationAttempt: 6,
    returnedChildCallId: "call-3", returnedResultRef: "result-2",
    completedChildren: [1, 2].map((index) => ({
      callerCallId: "call-1", childCallId: `call-${index + 1}`,
      resultRef: `result-${index}`, roleId: "worker",
      objective: `Child objective ${index}`, workingDirectory: ".",
      dependencyResultRefs: [], outcome: "completed", summary: "Result ".repeat(300),
    })),
  };
}

function memoryMessage(anchors = [0, 1, 2]): ChatMessage {
  return {
    role: "system",
    content: JSON.stringify({
      kind: "runtime_memory_recall_reference_v1",
      authority: "passive_reference", requestId: "request", callId: "call-1",
      steeringVersion: 0, omittedRecallCount: 3 - anchors.length,
      omittedRecordCount: 0,
      recalls: anchors.map((completedChildCount) => ({
        recallId: `recall-${completedChildCount + 1}`,
        invocationAttempt: 1 + 2 * completedChildCount,
        completedChildCount, query: `Query ${completedChildCount}`,
        outcome: "empty", memories: [], omittedRecordCount: 0,
      })),
    }),
  };
}

function resultOrder(messages: readonly ChatMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === "tool") return [message.toolCallId];
    try {
      const value = JSON.parse(message.content);
      return value.kind === "runtime_child_result" ? [value.childCallId] : [];
    } catch { return []; }
  });
}

test("interleaves accepted recalls before, between and after cumulative child results", () => {
  const parts = buildSupervisorMemoryRecallContinuationParts({
    memoryRecallMessage: memoryMessage(), resume: resume(),
    currentCallId: "call-1", currentInvocationAttempt: 6,
  });
  const full = parts.flatMap(({ messages }) => messages);
  const compact = parts.flatMap((part) => part.compactMessages ?? part.messages);
  const expected = ["recall-1", "call-2", "recall-2", "call-3", "recall-3"];
  expect(resultOrder(full)).toEqual(expected);
  expect(resultOrder(compact)).toEqual(expected);
  expect(() => validateModelGatewayMessages(full)).not.toThrow();
  expect(() => validateModelGatewayMessages(compact)).not.toThrow();
  expect(parts.map(({ retention }) => retention)).toEqual([
    "exact", "compactable", "exact", "compactable", "exact",
  ]);
});

test("omitted earlier recalls do not move retained recalls ahead of their child anchors", () => {
  const parts = buildSupervisorMemoryRecallContinuationParts({
    memoryRecallMessage: memoryMessage([1, 2]), resume: resume(),
    currentCallId: "call-1", currentInvocationAttempt: 6,
  });
  expect(resultOrder(parts.flatMap(({ messages }) => messages))).toEqual([
    "call-2", "recall-2", "call-3", "recall-3",
  ]);
});

test("normal context compaction preserves action/result pairs and the single current request", () => {
  const parts = buildSupervisorMemoryRecallContinuationParts({
    memoryRecallMessage: memoryMessage(), resume: resume(),
    currentCallId: "call-1", currentInvocationAttempt: 6,
  });
  const context = projectRequestContext({
    instructions: "Use the current request and its bounded evidence.",
    historyMessages: [], prompt: "CURRENT_REQUEST", continuationParts: parts,
    budget: {
      contextWindowTokens: 1000, outputReserveTokens: 100,
      safetyReserveTokens: 100, attachmentReserveTokens: 0,
    },
    deferCompactionFailure: true,
  });
  expect(context.compaction.applied).toBe(true);
  expect(context.messages.filter(({ role, content }) =>
    role === "user" && content === "CURRENT_REQUEST")).toHaveLength(1);
  expect(resultOrder(context.messages)).toEqual([
    "recall-1", "call-2", "recall-2", "call-3", "recall-3",
  ]);
  expect(() => validateModelGatewayMessages(context.messages)).not.toThrow();
});

test("rejects a child anchor outside the supplied snapshot instead of silently dropping its result", () => {
  expect(() => buildSupervisorMemoryRecallContinuationParts({
    memoryRecallMessage: memoryMessage([3]), resume: resume(),
    currentCallId: "call-1", currentInvocationAttempt: 6,
  })).toThrow("memory_recall_child_position_invalid");
});

const terminalCall = { rootCallId: "call-1", callId: "call-1", parentCallId: null, depth: 0, invocationAttempt: 6 };
const terminalOptions = { call: terminalCall, toolResults: { sourceRevision: 1, results: [] } };
const terminalInputs = [buildSupervisorResponseInput, buildSupervisorMemoryAuthoringInput];

test("both terminal authors receive rich linked recall results at the compact child boundaries", () => {
  const { request } = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => undefined });
  const source = JSON.parse(memoryMessage().content);
  source.requestId = request.requestId;
  source.omittedRecallCount = 1;
  source.omittedRecordCount = 7;
  source.recalls[0] = { ...source.recalls[0], outcome: "found", memories: [MEMORY_RECORD], omittedRecordCount: 2 };
  for (const build of terminalInputs) {
    const { messages } = build(request, {
      ...terminalOptions, resume: resume(), initialMemoryMessage: { role: "system", content: "INITIAL_ONLY" },
      memoryRecallMessage: { role: "system", content: JSON.stringify(source) },
    }).context;
    expect(resultOrder(messages)).toEqual(["recall-1", "call-2", "recall-2", "call-3", "recall-3"]);
    expect(messages.at(-1)).toMatchObject({ role: "user", content: request.prompt });
    expect(messages.filter(({ role }) => role === "assistant")).toHaveLength(3);
    expect(messages.map(({ content }) => content).join("")).not.toContain("INITIAL_ONLY");
    for (const recall of source.recalls) {
      const actionIndex = messages.findIndex(message => message.toolCalls?.[0]?.callId === recall.recallId);
      const action = messages[actionIndex]!;
      const result = messages[actionIndex + 1]!;
      expect(action).toMatchObject({ role: "assistant", toolCalls: [{ name: "recall_memory", callId: recall.recallId }] });
      expect(JSON.parse(action.toolCalls![0]!.arguments)).toEqual({ action: "recall_memory", query: recall.query });
      expect(result).toMatchObject({ role: "tool", toolName: "recall_memory", toolCallId: recall.recallId });
      const { query, ...expectedReceipt } = recall;
      expect(JSON.parse(result.content)).toEqual({ ...source, recalls: [expectedReceipt] });
      expect(result.content).not.toContain(query);
    }
    expect(() => validateModelGatewayMessages(messages)).not.toThrow();
  }
});

test("an omitted-only terminal snapshot projects counts without inventing a lookup", () => {
  const { request } = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => undefined });
  const source = { ...JSON.parse(memoryMessage([]).content), requestId: request.requestId, omittedRecordCount: 7,
    unexpectedText: "OMITTED_PRIVATE_TEXT" };
  const project = (build: typeof buildSupervisorResponseInput, omittedRecordCount: unknown) => build(request, {
    ...terminalOptions,
    memoryRecallMessage: { role: "system", content: JSON.stringify({ ...source, omittedRecordCount }) },
  }).context.messages;
  for (const build of terminalInputs) {
    const messages = project(build, 7);
    expect(messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).toContain("Omitted lookup results: 3. Omitted stored facts: 7.");
    expect(messages[0]?.content).not.toContain(source.unexpectedText);
    expect(() => project(build, source.unexpectedText)).toThrow("memory_recall_omission_counts_invalid");
  }
});
