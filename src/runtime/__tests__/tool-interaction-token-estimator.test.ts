import { describe, expect, test } from "vitest";

import type {
  ChatAssistantToolCallMessage,
  ChatMessage,
  ChatToolResultMessage,
  ModelTokenEstimationConfig,
} from "../../model-gateway/types.js";
import { projectRequestContext } from "../context/request-context.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
} from "../context/token-estimator.js";

const EXACT_CONFIG: ModelTokenEstimationConfig = {
  asciiCharactersPerToken: 1,
  nonAsciiBytesPerToken: 1,
  messageOverheadTokens: 5,
};

describe("native tool interaction token estimation", () => {
  test("counts every call item and result field without changing text estimates", () => {
    const callMessage: ChatAssistantToolCallMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        { callId: "id-1", name: "tool", arguments: '{"x":"123"}' },
        { callId: "id-2", name: "tool", arguments: '{"y":false}' },
      ],
    };
    const resultMessage: ChatToolResultMessage = {
      role: "tool",
      content: '{"ok":false}',
      toolCallId: "id-1",
      toolName: "tool",
    };

    const expectedCalls = callMessage.toolCalls.reduce(
      (total, call) =>
        total +
        5 +
        call.callId.length +
        call.name.length +
        call.arguments.length,
      0,
    );
    const expectedResult =
      5 +
      resultMessage.toolCallId.length +
      resultMessage.toolName.length +
      resultMessage.content.length;

    expect(estimateMessageTokens(callMessage, EXACT_CONFIG)).toBe(
      expectedCalls,
    );
    expect(estimateMessageTokens(resultMessage, EXACT_CONFIG)).toBe(
      expectedResult,
    );
    expect(
      estimateMessageTokens(
        { role: "assistant", content: "plain" },
        EXACT_CONFIG,
      ),
    ).toBe(10);
  });

  test("rejects exact continuation when oversized data exists only in call arguments", () => {
    const exactArguments = JSON.stringify({ payload: "x".repeat(2_000) });
    const callMessage: ChatAssistantToolCallMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          callId: "execution-large",
          name: "runtime_capability",
          arguments: exactArguments,
        },
      ],
    };
    const resultMessage: ChatToolResultMessage = {
      role: "tool",
      content: '{"ok":true}',
      toolCallId: "execution-large",
      toolName: "runtime_capability",
    };
    const continuationMessages: ChatMessage[] = [callMessage, resultMessage];
    const baselineCall: ChatAssistantToolCallMessage = {
      ...callMessage,
      toolCalls: [{ ...callMessage.toolCalls[0]!, arguments: "{}" }],
    };
    const baselineRequiredTokens = estimateMessagesTokens(
      [
        { role: "system", content: "rules" },
        { role: "user", content: "current" },
        baselineCall,
        resultMessage,
      ],
      EXACT_CONFIG,
    );
    const fullRequiredTokens = estimateMessagesTokens(
      [
        { role: "system", content: "rules" },
        { role: "user", content: "current" },
        ...continuationMessages,
      ],
      EXACT_CONFIG,
    );

    expect(fullRequiredTokens).toBeGreaterThan(baselineRequiredTokens);
    expect(() =>
      projectRequestContext({
        instructions: "rules",
        historyMessages: [],
        prompt: "current",
        continuationMessages,
        budget: {
          contextWindowTokens: baselineRequiredTokens,
          outputReserveTokens: 0,
          safetyReserveTokens: 0,
          attachmentReserveTokens: 0,
          formatTokenAccounting: { mode: "none" },
          tokenEstimation: EXACT_CONFIG,
        },
      }),
    ).toThrow("request_context_required_content_exceeds_budget");
    expect(callMessage.toolCalls[0]!.arguments).toBe(exactArguments);
    expect(resultMessage.content).toBe('{"ok":true}');

    const admitted = projectRequestContext({
      instructions: "rules",
      historyMessages: [],
      prompt: "current",
      continuationMessages,
      budget: {
        contextWindowTokens: fullRequiredTokens,
        outputReserveTokens: 0,
        safetyReserveTokens: 0,
        attachmentReserveTokens: 0,
        formatTokenAccounting: { mode: "none" },
        tokenEstimation: EXACT_CONFIG,
      },
    });
    const admittedCall = admitted.messages.find(
      (message): message is ChatAssistantToolCallMessage =>
        message.role === "assistant" && message.toolCalls !== undefined,
    );
    const admittedResult = admitted.messages.find(
      (message): message is ChatToolResultMessage => message.role === "tool",
    );
    expect(admittedCall?.toolCalls[0]?.arguments).toBe(exactArguments);
    expect(admittedResult?.content).toBe(resultMessage.content);
  });
});
