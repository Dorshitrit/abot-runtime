import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { performRootMemoryRecall } from "../request/root-memory-recall.js";
import {
  createRoleCallLedger,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
} from "../orchestration/role-calls/index.js";
import {
  createMemoryRecallHarness,
  FINAL_RESPONSE,
  MEMORY_RECORD,
  recallCapsules,
  RECALL_QUERY,
  REQUEST_PROMPT,
  responseDecision,
  type RecallPolicy,
} from "./support/memory-recall-runner.js";

const STEERING = "Use only my current presentation preference.";
const FRESH_QUERY = "current presentation preference";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test("settles recall superseded during admission without calling the service or emitting retrieval events", async () => {
  const harness = createMemoryRecallHarness({
    policy: "supervisor-worker-v1",
    decide: () => responseDecision("supervisor-worker-v1"),
    async retrieve({ context }) {
      context.onEvent?.("memory.retrieval.started");
      context.onEvent?.("memory.retrieval.completed");
      return { available: true, records: [MEMORY_RECORD] };
    },
  });
  const ledger = createRoleCallLedger({
    requestId: harness.request.requestId,
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      limits: {
        maxCalls: 8,
        maxDepth: 4,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: 8192,
        maxResultChars: 8192,
        maxResponseChars: 65536,
      },
    },
  });
  const created = await ledger.transactions!.createRoot({
    expectedHead: ledger.current(),
  });
  if (!created.ok) throw new Error(created.issueCode);
  ledger.commits.subscribe(({ effect }) => {
    if (effect.type !== "memory_recall_begun") return;
    if (effect.steeringVersion !== 0) return;
    harness.requestSteering.append({
      steerId: "during-recall-admission",
      text: STEERING,
    });
  });
  const initial = ledger.current();
  await performRootMemoryRecall({
    request: harness.request,
    ledger,
    head: initial,
    call: initial.state.calls[0]!,
    steeringVersion: 0,
    query: RECALL_QUERY,
  });
  expect(harness.memory.retrieve).not.toHaveBeenCalled();
  expect(harness.request.onEvent).not.toHaveBeenCalled();
  expect(ledger.current().state.memoryRecalls).toEqual([
    expect.objectContaining({
      status: "settled",
      steeringVersion: 0,
      result: {
        outcome: "superseded",
        records: [],
        omittedRecordCount: 0,
      },
    }),
  ]);
  const resumed = ledger.current();
  expect(resumed.state.calls[0]).toMatchObject({
    callId: initial.state.rootCallId,
    status: "active",
    activationCount: 2,
  });
  await performRootMemoryRecall({
    request: harness.request,
    ledger,
    head: resumed,
    call: resumed.state.calls[0]!,
    steeringVersion: 1,
    query: FRESH_QUERY,
  });
  expect(harness.memory.retrieve).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ query: FRESH_QUERY }),
  );
  expect(harness.request.onEvent).toHaveBeenCalledTimes(2);
  expect(ledger.current().state.memoryRecalls[1]).toMatchObject({
    status: "settled",
    steeringVersion: 1,
    result: { outcome: "found", records: [MEMORY_RECORD] },
  });
});

describe.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])(
  "%s memory recall steering",
  (policy) => {
    test("settles a superseded retrieval without projecting it and lets the same root recall afresh", async () => {
      let decisionCount = 0;
      const freshRecord = {
        ...MEMORY_RECORD,
        id: "fresh-preference",
        content: "Use one concise paragraph for this request.",
      };
      const harness = createMemoryRecallHarness({
        policy,
        async retrieve({ query }) {
          if (query === RECALL_QUERY) {
            harness.requestSteering.append({
              steerId: "during-recall",
              text: STEERING,
            });
            return { available: true, records: [MEMORY_RECORD] };
          }
          expect(query).toBe(FRESH_QUERY);
          return { available: true, records: [freshRecord] };
        },
        decide(input) {
          decisionCount += 1;
          if (decisionCount === 1) {
            return {
              action: "recall_memory",
              query: RECALL_QUERY,
              acknowledgement: "I will recall the relevant preference.",
            };
          }
          expect(JSON.stringify(input.messages)).toContain(STEERING);
          expect(JSON.stringify(recallCapsules(input))).not.toContain(
            MEMORY_RECORD.content,
          );
          if (decisionCount === 2) {
            expect(recallCapsules(input)).toEqual([]);
            return { action: "recall_memory", query: FRESH_QUERY };
          }
          expect(recallCapsules(input)).toEqual([
            expect.objectContaining({
              callId: "call-1",
              steeringVersion: 1,
              recalls: [
                expect.objectContaining({
                  query: FRESH_QUERY,
                  outcome: "found",
                  memories: [freshRecord],
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
      expect(decisionCount).toBe(3);
      expect(
        harness.memory.retrieve.mock.calls.map(([input]) => input.query),
      ).toEqual([RECALL_QUERY, FRESH_QUERY]);
      expect(harness.getAdapters).not.toHaveBeenCalled();
      expect(harness.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        FINAL_RESPONSE,
      );
    });

    test("rejects stale recall before retrieval when steering arrives during acknowledgement", async () => {
      let decisionCount = 0;
      const harness = createMemoryRecallHarness({
        policy,
        decide(input) {
          decisionCount += 1;
          if (decisionCount === 1) {
            return {
              action: "recall_memory",
              query: RECALL_QUERY,
              acknowledgement: "I will check the saved preference.",
            };
          }
          expect(recallCapsules(input)).toEqual([]);
          expect(JSON.stringify(input.messages)).toContain(STEERING);
          return responseDecision(policy);
        },
      });
      vi.mocked(harness.request.onAcknowledgement).mockImplementation(() => {
        harness.requestSteering.append({
          steerId: "before-recall",
          text: STEERING,
        });
      });
      await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
        output: FINAL_RESPONSE,
      });
      expect(
        harness.memory.retrieve.mock.calls.map(([input]) => input.query),
      ).toEqual([`${REQUEST_PROMPT}\n${STEERING}`]);
      expect(decisionCount).toBe(2);
    });

    test("rebuilds recalled context when steering changes during the resumed model decision", async () => {
      let decisionCount = 0;
      const harness = createMemoryRecallHarness({
        policy,
        decide(input) {
          decisionCount += 1;
          if (decisionCount === 1)
            return {
              action: "recall_memory",
              query: RECALL_QUERY,
              acknowledgement: "I will check memory.",
            };
          if (decisionCount === 2) {
            expect(recallCapsules(input)).toHaveLength(1);
            harness.requestSteering.append({
              steerId: "after-recall",
              text: STEERING,
            });
            return responseDecision(policy);
          }
          expect(recallCapsules(input)).toEqual([]);
          expect(JSON.stringify(input.messages)).toContain(STEERING);
          return responseDecision(policy);
        },
      });
      await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
        output: FINAL_RESPONSE,
      });
      expect(decisionCount).toBe(3);
      expect(harness.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        FINAL_RESPONSE,
      );
    });

    test("preserves cancellation during memory retrieval without another model call", async () => {
      const abortError = new Error("request cancelled during memory recall");
      const harness = createMemoryRecallHarness({
        policy,
        async retrieve() {
          harness.abortController.abort(abortError);
          throw abortError;
        },
        decide() {
          return {
            action: "recall_memory",
            query: RECALL_QUERY,
            acknowledgement: "I will check memory.",
          };
        },
      });
      await expect(runRequestRunner(harness.request)).rejects.toThrow(
        "request cancelled",
      );
      expect(harness.invoke).toHaveBeenCalledOnce();
      expect(harness.memory.retrieve).toHaveBeenCalledOnce();
      expect(harness.request.onAnswerToken).not.toHaveBeenCalled();
    });
  },
);
