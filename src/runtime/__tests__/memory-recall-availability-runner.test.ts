import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  type RecallModelInput,
  type RecallPolicy,
} from "./support/memory-recall-runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

function offersRecall(input: RecallModelInput): boolean {
  return JSON.stringify(input.format).includes('"recall_memory"');
}

function nonRecallDecisionVariants(input: RecallModelInput) {
  type Variant = { properties: { action: { enum: string[] } } };
  const format = input.format as {
    schema: { properties: { decision: Variant & { anyOf?: Variant[] } } };
  };
  const decision = format.schema.properties.decision;
  return (decision.anyOf ?? [decision]).filter(
    (variant) => !variant.properties.action.enum.includes("recall_memory"),
  );
}

function availabilityHarness(options: {
  policy: RecallPolicy;
  limit?: number;
  changingQuery?: boolean;
  outcome?: "found" | "empty" | "unavailable";
  steerDuringFirstRecall?: boolean;
}) {
  const limit = options.limit ?? 5;
  const outcome = options.outcome ?? "found";
  const offered: boolean[] = [];
  const decisions: RecallModelInput[] = [];
  let retrievalCount = 0;
  const harness = createMemoryRecallHarness({
    policy: options.policy,
    ...(options.limit !== undefined
      ? { memoryRecallLimit: options.limit }
      : {}),
    async retrieve() {
      retrievalCount += 1;
      if (options.steerDuringFirstRecall && retrievalCount === 1) {
        harness.requestSteering.append({
          steerId: "after-first-lookup",
          text: "Use the current stored preference in the answer.",
        });
      }
      return {
        available: outcome !== "unavailable",
        records: outcome === "found" ? [MEMORY_RECORD] : [],
        ...(outcome === "unavailable"
          ? { reason: "embedding_unavailable" }
          : {}),
      };
    },
    decide(input) {
      decisions.push(input);
      offered.push(offersRecall(input));
      // The last branch bounds the baseline regression before availability is implemented.
      if (!offersRecall(input) || decisions.length > limit) {
        return responseDecision(options.policy);
      }
      return {
        action: "recall_memory",
        query: options.changingQuery
          ? `Saved preference ${decisions.length}`
          : RECALL_QUERY,
        ...(decisions.length === 1
          ? { acknowledgement: "I will check the stored preference." }
          : {}),
      };
    },
  });
  return { ...harness, offered, decisions, limit };
}

function expectNormalCompletion(
  harness: ReturnType<typeof availabilityHarness>,
) {
  expect(harness.offered).toEqual([
    ...Array<boolean>(harness.limit).fill(true),
    false,
  ]);
  expect(harness.memory.retrieve).toHaveBeenCalledTimes(harness.limit);
  expect(harness.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
    FINAL_RESPONSE,
  );
  expect(harness.invokeRaw).not.toHaveBeenCalled();
  const finalDecision = harness.decisions.at(-1)!;
  expect(JSON.stringify(finalDecision.format)).toContain('"respond"');
  expect(nonRecallDecisionVariants(finalDecision)).toEqual(
    nonRecallDecisionVariants(harness.decisions.at(-2)!),
  );
  for (const [input] of harness.invoke.mock.calls) {
    expect(input.modelStep).not.toBe("degraded.finalization");
    expect(
      modelMessages(input).filter(
        ({ role, content }) => role === "user" && content === REQUEST_PROMPT,
      ),
    ).toHaveLength(1);
  }
}

describe.each<RecallPolicy>(["supervisor-worker-v1", "execution-agent-v1"])(
  "%s memory recall availability",
  (policy) => {
    test.each([
      { limit: undefined, changingQuery: false },
      { limit: 2, changingQuery: true },
      { limit: 7, changingQuery: true },
    ])(
      "removes recall after the request cap and preserves returned context (limit: $limit)",
      async (options) => {
        const harness = availabilityHarness({ policy, ...options });
        await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
          output: FINAL_RESPONSE,
        });
        expectNormalCompletion(harness);
        const finalDecision = harness.decisions.at(-1)!;
        const capsules = recallCapsules(finalDecision);
        expect(capsules).toEqual(expect.arrayContaining([
          expect.objectContaining({
            requestId: harness.request.requestId,
            callId: "call-1",
            steeringVersion: 0,
            recalls: expect.arrayContaining([
              expect.objectContaining({
                outcome: "found",
                memories: [MEMORY_RECORD],
              }),
            ]),
          }),
        ]));
        for (const capsule of capsules) {
          expect(capsule).toMatchObject({
            requestId: harness.request.requestId,
            callId: "call-1",
            steeringVersion: 0,
            authority: "passive_reference",
          });
          expect(capsule.recalls).toHaveLength(1);
        }
        const responses = harness.invoke.mock.calls.filter(([input]) =>
          ["supervisor.response", "execution.response"].includes(
            String(input.modelStep),
          ),
        );
        expect(responses.length).toBeGreaterThan(0);
        for (const [input] of responses)
          expect(recallCapsules(input).flatMap(({ recalls }) => recalls))
            .toEqual(capsules.flatMap(({ recalls }) => recalls));
      },
    );

    test.each(["empty", "unavailable"] as const)(
      "counts %s lookups and retains the receipt for normal response",
      async (outcome) => {
        const harness = availabilityHarness({ policy, limit: 2, outcome });
        await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
          output: FINAL_RESPONSE,
        });
        expectNormalCompletion(harness);
        const capsules = recallCapsules(harness.decisions.at(-1)!);
        expect(capsules.flatMap(({ recalls }) => recalls)).toEqual([
          expect.objectContaining({ outcome, memories: [] }),
          expect.objectContaining({ outcome, memories: [] }),
        ]);
        const responses = harness.invoke.mock.calls.filter(([input]) =>
          ["supervisor.response", "execution.response"].includes(
            String(input.modelStep),
          ),
        );
        for (const [input] of responses)
          expect(recallCapsules(input).flatMap(({ recalls }) => recalls))
            .toEqual(capsules.flatMap(({ recalls }) => recalls));
      },
    );

    test("a fresh request receives a fresh availability budget", async () => {
      for (const requestId of [
        "first-recall-request",
        "second-recall-request",
      ]) {
        const harness = availabilityHarness({ policy, limit: 2 });
        const request = deriveTestRequestExecutionScope(harness.request, {
          requestId,
        });
        await expect(runRequestRunner(request)).resolves.toMatchObject({
          output: FINAL_RESPONSE,
        });
        expectNormalCompletion(harness);
        expect(recallCapsules(harness.decisions.at(-1)!)[0]).toMatchObject({
          requestId,
        });
      }
    });

    test("steering does not renew consumed calls and only current recall data remains", async () => {
      const harness = availabilityHarness({
        policy,
        limit: 2,
        steerDuringFirstRecall: true,
      });
      await expect(runRequestRunner(harness.request)).resolves.toMatchObject({
        output: FINAL_RESPONSE,
      });
      expectNormalCompletion(harness);
      expect(recallCapsules(harness.decisions.at(-1)!)).toEqual([
        expect.objectContaining({
          steeringVersion: 1,
          recalls: [
            expect.objectContaining({
              recallId: "recall-2",
              memories: [MEMORY_RECORD],
            }),
          ],
        }),
      ]);
    });
  },
);
