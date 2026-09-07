import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createMemoryRecallHarness,
  FINAL_RESPONSE,
  MEMORY_RECORD,
  modelMessages,
  recallCapsules,
  RECALL_QUERY,
  REQUEST_PROMPT,
  responseDecision,
  type RecallPolicy,
} from "./support/memory-recall-runner.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])(
  "%s explicit memory recall",
  (policy) => {
    test("returns source-bearing passive memory to the same root and reuses it for response", async () => {
      let decisionCount = 0;
      const harness = createMemoryRecallHarness({
        policy,
        decide(input) {
          decisionCount += 1;
          if (decisionCount === 1) {
            expect(recallCapsules(input)).toEqual([]);
            return {
              action: "recall_memory",
              query: RECALL_QUERY,
              acknowledgement: "I will recall the relevant preference.",
            };
          }
          expect(decisionCount).toBe(2);
          const messages = modelMessages(input);
          expect(() => validateModelGatewayMessages(messages)).not.toThrow();
          expect(messages.slice(-3)).toMatchObject([
            { role: "user", content: REQUEST_PROMPT },
            {
              role: "assistant",
              toolCalls: [{ callId: "recall-1", name: "recall_memory" }],
            },
            { role: "tool", toolCallId: "recall-1", toolName: "recall_memory" },
          ]);
          expect(messages.filter(({ role, content }) =>
            role === "system" && content.includes('"recallId"'),
          )).toEqual([]);
          expect(recallCapsules(input)).toEqual([
            expect.objectContaining({
              callId: "call-1",
              steeringVersion: 0,
              recalls: [
                expect.objectContaining({
                  recallId: expect.any(String),
                  query: RECALL_QUERY,
                  outcome: "found",
                  memories: [MEMORY_RECORD],
                  omittedRecordCount: 0,
                }),
              ],
            }),
          ]);
          return responseDecision(policy);
        },
      });
      await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
        output: FINAL_RESPONSE,
      });
      expect(harness.memory.retrieve).toHaveBeenCalledExactlyOnceWith({
        query: RECALL_QUERY,
        context: expect.objectContaining({
          requestId: harness.request.requestId,
          sessionId: harness.request.sessionId,
          abortSignal: harness.request.abortSignal,
        }),
      });
      expect(harness.getAdapters).not.toHaveBeenCalled();
      expect(harness.invokeRaw).not.toHaveBeenCalled();
      const inputs = harness.invoke.mock.calls.map(([input]) => input);
      const responseInputs = inputs.filter(
        ({ modelStep }) =>
          modelStep === "supervisor.response" ||
          modelStep === "execution.response",
      );
      expect(responseInputs.length).toBeGreaterThan(0);
      for (const input of responseInputs) {
        expect(recallCapsules(input)).toHaveLength(1);
        expect(JSON.stringify(recallCapsules(input))).toContain(
          MEMORY_RECORD.content,
        );
      }
      for (const input of inputs) {
        const messages = modelMessages(input);
        expect(
          messages.filter(
            ({ role, content }) =>
              role === "user" && content === REQUEST_PROMPT,
          ),
        ).toHaveLength(1);
        const isPostRecallDecision = input === inputs[1];
        expect(messages.some(({ role }) => role === "tool")).toBe(isPostRecallDecision);
      }
      const forbiddenSteps = new Set([
        "planner.decision",
        "worker.decision",
        "reviewer.decision",
        "capability.controls",
        "tool_payload.raw",
      ]);
      expect(
        inputs.filter(({ modelStep }) => forbiddenSteps.has(String(modelStep))),
      ).toEqual([]);
      expect(harness.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        FINAL_RESPONSE,
      );
    });

    test.each([
      { outcome: "empty", retrieval: { available: true, records: [] } },
      {
        outcome: "unavailable",
        retrieval: {
          available: false,
          records: [],
          reason: "embedding_unavailable",
        },
      },
    ])(
      "continues with $outcome without another retrieval attempt",
      async ({ outcome, retrieval }) => {
        let decisionCount = 0;
        const harness = createMemoryRecallHarness({
          policy,
          retrieve: async () => retrieval,
          decide(input) {
            decisionCount += 1;
            if (decisionCount === 1) {
              return {
                action: "recall_memory",
                query: RECALL_QUERY,
                acknowledgement: "I will check memory.",
              };
            }
            expect(recallCapsules(input)).toEqual([
              expect.objectContaining({
                recalls: [expect.objectContaining({ outcome, memories: [] })],
              }),
            ]);
            return responseDecision(policy);
          },
        });
        await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
          output: FINAL_RESPONSE,
        });
        expect(decisionCount).toBe(2);
        expect(harness.memory.retrieve).toHaveBeenCalledOnce();
        expect(harness.getAdapters).not.toHaveBeenCalled();
      },
    );

    test("does not offer or retrieve recall when memory is disabled", async () => {
      const harness = createMemoryRecallHarness({
        policy,
        enabled: false,
        decide(input) {
          expect(JSON.stringify(input.format)).not.toContain("recall_memory");
          expect(recallCapsules(input)).toEqual([]);
          return {
            ...responseDecision(policy),
            acknowledgement: "I will answer the request.",
          };
        },
      });
      await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
        output: FINAL_RESPONSE,
      });
      expect(harness.memory.retrieve).not.toHaveBeenCalled();
      expect(harness.invoke.mock.calls).toHaveLength(2);
    });

    test("keeps automatic terminal retrieval for an unrelated request without explicit recall", async () => {
      const harness = createMemoryRecallHarness({
        policy,
        decide(input) {
          expect(recallCapsules(input)).toEqual([]);
          return {
            ...responseDecision(policy),
            acknowledgement: "I will answer the request.",
          };
        },
      });
      await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
        output: FINAL_RESPONSE,
      });
      expect(
        harness.memory.retrieve.mock.calls.map(([input]) => input.query),
      ).toEqual([REQUEST_PROMPT]);
      for (const [input] of harness.invoke.mock.calls) {
        expect(recallCapsules(input)).toEqual([]);
      }
    });
  },
);
