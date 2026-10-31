import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createRequestSteeringInbox,
  REQUEST_STEERING_MESSAGE_KIND,
} from "../request/request-steering.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  runnerConfig,
  modelPolicy,
  separateSupervisorRunnerModelPhases,
} from "./support/supervisor-runner-model-phases.js";
import { workerEvidenceReply } from "./support/worker-evidence-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function capsules(
  input: Parameters<ModelGatewayClient["invoke"]>[0],
  kind: string,
): Record<string, unknown>[] {
  return (input.messages as ChatMessage[]).flatMap(({ content }) => {
    try {
      const parsed = JSON.parse(content);
      return parsed?.kind === kind ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
function reply(decision: unknown) {
  return { text: JSON.stringify({ decision }), meta: {} };
}

function createFixture(
  invoke: ModelGatewayClient["invoke"],
  steering: ReturnType<typeof createRequestSteeringInbox>,
) {
  return createTestRequestExecutionScope({
    requestId: "steering-chain",
    sessionId: "steering-chain-session",
    prompt: "Complete the original project tasks.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig,
    modelPolicy,
    agentMode: "reasoning",
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    requestSteering: steering,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters: () => [],
    },
    modelGatewayClient: {
      invoke: separateSupervisorRunnerModelPhases(invoke, {
        planner: ".",
        worker: ".",
      }),
      invokeRaw: vi.fn(),
    },
  });
}

test.each(["supervisor", "planner"] as const)(
  "new steering returns Worker to %s before accepting stale output",
  async (caller) => {
    const steering = createRequestSteeringInbox({
      requestId: "steering-chain",
    });
    let rootDecisions = 0;
    let plannerDecisions = 0;
    let workerResults = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === "supervisor.decision") {
        rootDecisions += 1;
        if (rootDecisions === 1)
          return reply({
            action: "invoke_role",
            roleId: caller === "supervisor" ? "worker" : "planner",
            objective: "Complete the assigned project work.",
          });
        expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toHaveLength(1);
        return reply({ action: "respond" });
      }
      if (input.modelStep === "planner.decision") {
        plannerDecisions += 1;
        if (plannerDecisions === 1)
          return reply({
            action: "invoke_role",
            roleId: "worker",
            plan: {
              summary: "Original work.",
              items: [
                {
                  title: "Current task",
                  objective: "Complete the current task.",
                },
                {
                  title: "Future task",
                  objective: "Produce the exact remaining artifact.",
                },
              ],
            },
            selectedItemIndexes: [0],
          });
        expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toEqual([
          expect.objectContaining({
            authority: "user",
            version: 1,
            updates: [{ sequence: 1, text: "Stop now." }],
          }),
        ]);
        expect(capsules(input, "runtime_child_result")).toEqual([
          expect.objectContaining({ outcome: "yielded", steeringVersion: 1 }),
        ]);
        expect(capsules(input, "runtime_planner_assignment")[0]).toMatchObject({
          retiredWork: {
            entries: [
              {
                title: "Current task",
                objective: "Complete the current task.",
              },
              {
                title: "Future task",
                objective: "Produce the exact remaining artifact.",
              },
            ],
          },
        });
        return reply({
          action: "return_result",
          result:
            "Stopped at the user's request; original tasks remain incomplete.",
        });
      }
      if (input.modelStep === "worker.evidence")
        return workerEvidenceReply(input, false);
      if (input.modelStep === "worker.result") {
        workerResults += 1;
        expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toHaveLength(0);
        steering.append({ steerId: "stop", text: "Stop now." });
        return { text: "STALE_WORKER_SUCCESS", meta: {} };
      }
      if (input.modelStep === "supervisor.response") {
        expect(JSON.stringify(input.messages)).not.toContain(
          "STALE_WORKER_SUCCESS",
        );
        return {
          text: "Stopped. The unfinished work was not completed.",
          meta: {},
        };
      }
      throw new Error(`Unexpected step ${input.modelStep}`);
    });
    const request = createFixture(invoke, steering);
    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Stopped. The unfinished work was not completed.",
    });
    expect(workerResults).toBe(1);
    expect(plannerDecisions).toBe(caller === "planner" ? 2 : 0);
  },
);

test("Planner replaces only remaining work after a yielded child and the same steering does not yield again", async () => {
  const steering = createRequestSteeringInbox({ requestId: "steering-chain" });
  let rootDecisions = 0;
  let plannerDecisions = 0;
  let workerResults = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "supervisor.decision")
      return reply(
        ++rootDecisions === 1
          ? {
              action: "invoke_role",
              roleId: "planner",
              objective: "Complete the project task.",
            }
          : { action: "respond" },
      );
    if (input.modelStep === "planner.decision") {
      plannerDecisions += 1;
      if (plannerDecisions === 1)
        return reply({
          action: "invoke_role",
          roleId: "worker",
          plan: {
            summary: "Initial assignment.",
            items: [{ title: "Original", objective: "Do the original work." }],
          },
          selectedItemIndexes: [0],
        });
      expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toHaveLength(1);
      if (plannerDecisions === 2)
        return reply({
          action: "invoke_role",
          roleId: "worker",
          extension: {
            items: [
              {
                title: "Replacement",
                objective: "Summarize only the retained result.",
              },
            ],
          },
          selectedItemIndexes: [0],
        });
      expect(
        capsules(input, "runtime_child_result").map((value) => value.outcome),
      ).toEqual(["yielded", "completed"]);
      return reply({
        action: "return_result",
        result: "The replacement assignment finished.",
      });
    }
    if (input.modelStep === "worker.evidence")
      return workerEvidenceReply(input, false);
    if (input.modelStep === "worker.result") {
      expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toHaveLength(0);
      workerResults += 1;
      if (workerResults === 1)
        steering.append({
          steerId: "redirect",
          text: "Only summarize the retained result.",
        });
      if (workerResults === 2)
        expect(JSON.stringify(input.messages)).toContain(
          "Summarize only the retained result.",
        );
      return {
        text: workerResults === 1 ? "STALE" : "The requested summary.",
        meta: {},
      };
    }
    if (input.modelStep === "supervisor.response")
      return { text: "The requested summary.", meta: {} };
    throw new Error(`Unexpected step ${input.modelStep}`);
  });
  await expect(
    runRequestRunner(createFixture(invoke, steering)),
  ).resolves.toEqual({ output: "The requested summary." });
  expect(workerResults).toBe(2);
  expect(plannerDecisions).toBe(3);
});

test("Supervisor delegates an added requirement after Worker yield without a user confirmation round", async () => {
  const steering = createRequestSteeringInbox({ requestId: "steering-chain" });
  let rootDecisions = 0;
  let workerEvidence = 0;
  let workerResults = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "supervisor.decision") {
      rootDecisions += 1;
      if (rootDecisions === 1)
        return reply({
          action: "invoke_role",
          roleId: "worker",
          objective: "Find technology articles.",
        });
      if (rootDecisions === 2) {
        expect(capsules(input, "runtime_child_result")).toEqual([
          expect.objectContaining({ outcome: "yielded", steeringVersion: 1 }),
        ]);
        expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toEqual([
          expect.objectContaining({
            version: 1,
            updates: [{ sequence: 1, text: "Include GPT articles too." }],
          }),
        ]);
        return reply({
          action: "invoke_role",
          roleId: "worker",
          objective: "Find technology articles including GPT articles.",
        });
      }
      expect(
        capsules(input, "runtime_child_result").map((child) => child.outcome),
      ).toEqual(["yielded", "completed"]);
      return reply({ action: "respond" });
    }
    if (input.modelStep === "worker.evidence") {
      workerEvidence += 1;
      if (workerEvidence === 1)
        steering.append({
          steerId: "add-gpt",
          text: "Include GPT articles too.",
        });
      else {
        expect(JSON.stringify(input.messages)).toContain(
          "Find technology articles including GPT articles.",
        );
        expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toEqual([]);
      }
      return workerEvidenceReply(input, false);
    }
    if (input.modelStep === "worker.result") {
      workerResults += 1;
      return {
        text: "The requested technology and GPT article summary.",
        meta: {},
      };
    }
    if (input.modelStep === "supervisor.response") {
      expect(
        capsules(input, "runtime_child_result").map((child) => child.outcome),
      ).toEqual(["yielded", "completed"]);
      return {
        text: "The requested technology and GPT article summary.",
        meta: {},
      };
    }
    throw new Error(`Unexpected step ${input.modelStep}`);
  });
  await expect(
    runRequestRunner(createFixture(invoke, steering)),
  ).resolves.toEqual({
    output: "The requested technology and GPT article summary.",
  });
  expect(rootDecisions).toBe(3);
  expect(workerEvidence).toBe(2);
  expect(workerResults).toBe(1);
});
