import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { buildSparkConversationInstructions } from "../context/spark-conversation-policy.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { initiative, memoryFor, ordinaryTurn, session } from "./support/initiative-session-memory-fixture.js";
import { createMemoryRecallHarness, modelMessages, recallCapsules, responseDecision,
  type RecallPolicy } from "./support/memory-recall-runner.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

describe.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])(
  "%s conversation history after empty long-term recall", (policy) => {
    test.each([true, false])("retains ordinary assistant chronology (marked SPARK=%s)", async (markedSpark) => {
      const record = session([initiative(0), ...ordinaryTurn(0)]);
      const prompt = "What did you suggest at the start of this conversation?";
      const query = "earlier suggestion";
      const { memory: sessionMemory } = memoryFor(record);
      let decisionCount = 0;
      const harness = createMemoryRecallHarness({
        policy,
        retrieve: async () => ({ available: true, records: [] }),
        decide(input) {
          decisionCount += 1;
          if (decisionCount === 1) {
            expect(recallCapsules(input)).toEqual([]);
            return { action: "recall_memory", query, acknowledgement: "Checking saved facts." };
          }
          expect(decisionCount).toBe(2);
          expect(recallCapsules(input)).toEqual([expect.objectContaining({
            requestId: harness.request.requestId, callId: "call-1", steeringVersion: 0,
            recalls: [expect.objectContaining({ query, outcome: "empty", memories: [], omittedRecordCount: 0 })],
          })]);
          return responseDecision(policy);
        },
      });
      const request = deriveTestRequestExecutionScope(harness.request, {
        sessionId: record.id, sessionKind: markedSpark ? "spark" : undefined,
        prompt, historyMessages: [], sessionMemory,
      });
      await runRequestRunner(request);
      expect(decisionCount).toBe(2);
      expect(harness.memory.retrieve).toHaveBeenCalledExactlyOnceWith({
        query, context: expect.objectContaining({ requestId: request.requestId, sessionId: record.id }),
      });
      expect(harness.getAdapters).not.toHaveBeenCalled();
      expect(harness.invokeRaw).not.toHaveBeenCalled();
      const policyBlock = buildSparkConversationInstructions("spark").join("\n");
      const expectedConversation = [...record.messages.map(({ role, content }) => ({ role, content })),
        { role: "user", content: prompt }];
      const conversationContents = new Set(expectedConversation.map(({ content }) => content));
      const inputs = harness.invoke.mock.calls.map(([input]) => input);
      expect(inputs.filter(({ modelStep }) => String(modelStep).endsWith("response")).length).toBeGreaterThan(0);
      for (const [index, input] of inputs.entries()) {
        const messages = modelMessages(input);
        expect(() => validateModelGatewayMessages(messages)).not.toThrow();
        expect(messages.filter(({ content }) => conversationContents.has(content)))
          .toEqual(expectedConversation);
        expect(messages.filter(({ role, content }) => role === "user" && content === prompt)).toHaveLength(1);
        const separateMemoryAuthoring = input.modelStep === "supervisor.response" && Boolean(input.format);
        expect(messages.filter(({ content }) => content.includes(policyBlock)))
          .toHaveLength(markedSpark && !separateMemoryAuthoring ? 1 : 0);
        expect(JSON.stringify(messages)).not.toContain("runtime_spark_initiative_reference_v1");
        expect(JSON.stringify(messages)).not.toContain("Private reason");
        expect(JSON.stringify(messages)).not.toContain("Private handoff");
        expect(recallCapsules(input)).toHaveLength(index === 0 ? 0 : 1);
      }
    });
  },
);
