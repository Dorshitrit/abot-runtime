import { workerEvidenceDecision } from "./support/worker-evidence-script.js";
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

import { supervisorFormatName } from "./support/supervisor-model-phases.js";

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

/** Initial SUPER cannot recall: complete a real child before exercising root recall. */
function createRecallAfterChildHarness(options: Parameters<typeof createMemoryRecallHarness>[0]) {
  if (options.policy !== "supervisor-worker-v1") return createMemoryRecallHarness(options);
  return createMemoryRecallHarness({
    ...options,
    classifyProcedure: () => ({ requiresProcedure: true }),
    delegate: () => ({ action: "invoke_role", roleId: "worker", objective: "Check whether the saved preference is needed." }),
    decide(input) {
      if (supervisorFormatName(input) === "supervisor_working_directory") return JSON.stringify({ workingDirectory: "." });
      if (input.modelStep === "worker.evidence") return workerEvidenceDecision(input, false);
      if (input.modelStep === "worker.result") return "The current request requires the saved preference.";
      expect(supervisorFormatName(input)).toBe("supervisor_decision");
      return options.decide(input);
    },
  });
}

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
      const harness = createRecallAfterChildHarness({
        policy,
        async retrieve({ query }) {
          if (query === REQUEST_PROMPT)
            return { available: true, records: [MEMORY_RECORD] };
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
          return policy === "supervisor-worker-v1" ? { action: "respond" } : responseDecision(policy);
        },
      });
      await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
        output: FINAL_RESPONSE,
      });
      expect(decisionCount).toBe(3);
      expect(
        harness.memory.retrieve.mock.calls.map(([input]) => input.query),
      ).toEqual([REQUEST_PROMPT, RECALL_QUERY, FRESH_QUERY]);
      if (policy === "execution-agent-v1") expect(harness.getAdapters).not.toHaveBeenCalled();
      else expect(harness.gatewayInvoke.mock.calls.filter(([input]) => input.modelStep === "worker.evidence")).toHaveLength(1);
      expect(harness.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        FINAL_RESPONSE,
      );
    });

    test(policy === "supervisor-worker-v1"
      ? "rejects stale recall before retrieval when steering arrives during returned decision acceptance"
      : "rejects stale recall before retrieval when steering arrives during acknowledgement", async () => {
      let decisionCount = 0;
      const harness = createRecallAfterChildHarness({
        policy,
        decide(input) {
          decisionCount += 1;
          if (decisionCount === 1) {
            if (policy === "supervisor-worker-v1") harness.requestSteering.append({
              steerId: "before-recall", text: STEERING,
            });
            return {
              action: "recall_memory", query: RECALL_QUERY,
              acknowledgement: "I will check the saved preference.",
            };
          }
          expect(recallCapsules(input)).toEqual([]);
          expect(JSON.stringify(input.messages)).toContain(STEERING);
          return policy === "supervisor-worker-v1" ? { action: "respond" } : responseDecision(policy);
        },
      });
      if (policy === "execution-agent-v1") vi.mocked(harness.request.onAcknowledgement).mockImplementation(() => {
        harness.requestSteering.append({ steerId: "before-recall", text: STEERING });
      });
      await expect(runRequestRunner(harness.request)).resolves.toMatchObject({ output: FINAL_RESPONSE });
      expect(harness.memory.retrieve.mock.calls.map(([input]) => input.query)).toEqual([REQUEST_PROMPT]);
      expect(decisionCount).toBe(2);
    });

    test("rebuilds recalled context when steering changes during the resumed model decision", async () => {
      let decisionCount = 0;
      const harness = createRecallAfterChildHarness({
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
            return policy === "supervisor-worker-v1" ? { action: "respond" } : responseDecision(policy);
          }
          expect(recallCapsules(input)).toEqual([]);
          expect(JSON.stringify(input.messages)).toContain(STEERING);
          return policy === "supervisor-worker-v1" ? { action: "respond" } : responseDecision(policy);
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
      const harness = createRecallAfterChildHarness({
        policy,
        async retrieve({ query }) {
          if (query === REQUEST_PROMPT)
            return { available: true, records: [] };
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
      const rootCalls = harness.invoke.mock.calls.filter(([input]) =>
        input.modelStep === "execution.decision" || supervisorFormatName(input) === "supervisor_decision");
      expect(rootCalls).toHaveLength(1);
      expect(harness.invoke.mock.calls.at(-1)![0]).toBe(rootCalls[0]![0]);
      expect(harness.memory.retrieve).toHaveBeenCalledTimes(2);
      expect(harness.request.onAnswerToken).not.toHaveBeenCalled();
    });
  },
);


test("EA cancellation during its initial automatic lookup prevents the first model call", async () => {
  const failure = new Error("initial memory preparation cancelled");
  const harness = createMemoryRecallHarness({
    policy: "execution-agent-v1",
    async retrieve() {
      harness.abortController.abort(failure);
      throw failure;
    },
    decide: () => responseDecision("execution-agent-v1"),
  });
  await expect(runRequestRunner(harness.request)).rejects.toBe(failure);
  expect(harness.memory.retrieve).toHaveBeenCalledOnce();
  expect(harness.invoke).not.toHaveBeenCalled();
  expect(harness.request.onAnswerToken).not.toHaveBeenCalled();
});
