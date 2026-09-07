import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
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
