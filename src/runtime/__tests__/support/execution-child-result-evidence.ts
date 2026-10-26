import { expect } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import {
  EXECUTION_ROLE_ACTION_MESSAGE_KIND,
  EXECUTION_ROLE_RESULT_MESSAGE_KIND,
  EXECUTION_ROLE_TOOL_NAME,
} from "../../steps/execution-agent/child-continuation.js";
import {
  auditMessages,
  readAuditCapsule,
  type AuditRunnerInput,
} from "./auditor-runner-fixture.js";

export type ExecutionChildResultReference = Readonly<{
  resultRef: string;
  roleId: string;
  outcome: string;
  summary?: string;
  evidenceLane?: "chronological_native_role_result";
}>;
export type ExecutionChildResultEvidence = ExecutionChildResultReference & Readonly<{ summary: string }>;

type ChildBinding = Readonly<{
  callerCallId: string;
  childCallId: string;
  roleId: string;
  parentInvocationAttempt: number;
}>;
type NativeChildResult = ChildBinding & Readonly<{
  kind: string;
  authority: string;
  result: { resultRef: string; outcome: string; summary: string };
}>;

/** Read only evidence actually visible to the mocked root model, never ledger internals. */
export function readExecutionChildResultEvidence(
  input: AuditRunnerInput,
): readonly ExecutionChildResultEvidence[] {
  const state = readAuditCapsule<{
    callId: string;
    completedSubordinateResults: readonly ExecutionChildResultReference[];
  }>(input, "runtime_execution_state_v1");
  const messages = auditMessages(input);
  return state.completedSubordinateResults.map((reference) => {
    if (reference.evidenceLane === undefined) {
      expect(typeof reference.summary).toBe("string");
      return { ...reference, summary: reference.summary! };
    }
    expect(reference.evidenceLane).toBe("chronological_native_role_result");
    expect(reference).not.toHaveProperty("summary");
    return readBoundNativeChildResult(messages, state.callId, reference);
  });
}

function readBoundNativeChildResult(
  messages: readonly ChatMessage[],
  callerCallId: string,
  reference: ExecutionChildResultReference,
): ExecutionChildResultEvidence {
  const candidates = messages.flatMap((message, index) => {
    if (message.role !== "tool") return [];
    if (message.toolName !== EXECUTION_ROLE_TOOL_NAME) return [];
    const content = JSON.parse(message.content) as NativeChildResult;
    if (content.result?.resultRef !== reference.resultRef) return [];
    return [{ message, content, index }];
  });
  expect(candidates, `native child evidence for ${reference.resultRef}`).toHaveLength(1);
  const { message, content, index } = candidates[0]!;
  expect(content.kind).toBe(EXECUTION_ROLE_RESULT_MESSAGE_KIND);
  expect(content.authority).toBe("canonical_role_call_ledger");
  expect(content.callerCallId).toBe(callerCallId);
  expect(content.roleId).toBe(reference.roleId);
  expect(content.result.outcome).toBe(reference.outcome);
  expect(typeof content.result.summary).toBe("string");
  expect(message.toolCallId).toBe(`role-call:${content.childCallId}`);
  expectBoundAcceptedChildAction(messages, index, message.toolCallId, content);
  return { ...reference, summary: content.result.summary };
}

function expectBoundAcceptedChildAction(
  messages: readonly ChatMessage[],
  resultIndex: number,
  toolCallId: string,
  binding: ChildBinding,
): void {
  const calls = messages.flatMap((message, index) => {
    if (message.role !== "assistant") return [];
    return (message.toolCalls ?? []).filter((call) => call.callId === toolCallId)
      .map((call) => ({ call, index }));
  });
  expect(calls, `accepted child action for ${toolCallId}`).toHaveLength(1);
  const { call, index } = calls[0]!;
  expect(index).toBeLessThan(resultIndex);
  expect(call.name).toBe(EXECUTION_ROLE_TOOL_NAME);
  expect(JSON.parse(call.arguments)).toMatchObject({
    kind: EXECUTION_ROLE_ACTION_MESSAGE_KIND,
    authority: "canonical_role_call_ledger",
    callerCallId: binding.callerCallId,
    childCallId: binding.childCallId,
    roleId: binding.roleId,
    parentInvocationAttempt: binding.parentInvocationAttempt,
  });
}
