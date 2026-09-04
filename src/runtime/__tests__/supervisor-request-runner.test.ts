import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createDefaultToolRegistry } from "../default-adapters.js";
import type {
  ModelGatewayClient,
  RuntimeConfig,
  ToolRegistry,
} from "../ports.js";
import type {
  RegisteredToolNormalInvocation,
  ToolExecutionResult,
  ToolNormalInvocationOperation,
} from "../../capabilities/tool-types.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
} from "../orchestration/role-calls/index.js";
import {
  createRoleExecutorRegistry,
  type RoleExecutor,
} from "../orchestration/role-executors/index.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import {
  createTestRequestExecutionScope,
  createTestRequestExecutionScopeWithCapabilities,
  rebindTestRequestExecutionPolicy,
  type TestRequestSeed,
} from "./support/request-execution-scope.js";
import type {
  RequestObservation,
  RequestRoleExecutionHandoff,
} from "../request/result.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createRequestSteeringInbox,
  REQUEST_STEERING_MESSAGE_KIND,
} from "../request/request-steering.js";
import {
  runSupervisorRootExecution,
  SUPERVISOR_ROOT_CONTRACT,
} from "../request/supervisor-root-execution.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import {
  CAPABILITY_CONTROLS_MODEL_STEP,
  WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
} from "../orchestration/worker-capabilities/index.js";
import { PLANNER_DECISION_MODEL_STEP } from "../steps/planner-decision/index.js";
import { REVIEWER_DECISION_MODEL_STEP } from "../steps/reviewer-decision/index.js";
import { SUPERVISOR_DECISION_MODEL_STEP } from "../steps/supervisor-decision/index.js";
import { SUPERVISOR_RESPONSE_MODEL_STEP } from "../steps/supervisor-response/index.js";
import {
  WORKER_DECISION_MODEL_STEP,
  WORKER_RESULT_MODEL_STEP,
} from "../steps/worker-decision/index.js";

const runnerConfig: RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: "runtime-default",
      steps: {
        [SUPERVISOR_DECISION_MODEL_STEP]: "supervisor.decision",
        [SUPERVISOR_RESPONSE_MODEL_STEP]: "supervisor.response",
        [PLANNER_DECISION_MODEL_STEP]: "planner.decision",
        [REVIEWER_DECISION_MODEL_STEP]: "reviewer.decision",
        [WORKER_DECISION_MODEL_STEP]: "worker.decision",
        [WORKER_RESULT_MODEL_STEP]: "supervisor.response",
        [CAPABILITY_CONTROLS_MODEL_STEP]: "capability.controls",
        [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: "toolPayload.raw",
      },
    },
  },
  context: {
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
  steps: {
    [SUPERVISOR_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
    [SUPERVISOR_RESPONSE_MODEL_STEP]: { timeoutMs: 20_000 },
    [PLANNER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
    [REVIEWER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
    [WORKER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
    [WORKER_RESULT_MODEL_STEP]: { timeoutMs: 20_000 },
    [CAPABILITY_CONTROLS_MODEL_STEP]: { timeoutMs: 20_000 },
    [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: { timeoutMs: 20_000 },
  } as RequestRunnerConfig["steps"],
};

const capabilityRunnerConfig = runnerConfig;
const mutationRunnerConfig = runnerConfig;
const REQUEST_ACKNOWLEDGEMENT =
  "I understand the requested outcome and am starting now.";
const PLANNER_WORKING_DIRECTORY = "projects/planner-request-runner";
const DIRECT_WORKER_WORKING_DIRECTORY = ".";

function encodeDecision(decision: unknown): string {
  return JSON.stringify({ decision });
}

function findSteeringMessage(
  messages: readonly Readonly<{ role: string; content: string }>[] | undefined,
): Readonly<{ role: string; content: string }> | undefined {
  return messages?.find((message) => {
    try {
      return (
        (JSON.parse(message.content) as Record<string, unknown>).kind ===
        REQUEST_STEERING_MESSAGE_KIND
      );
    } catch {
      return false;
    }
  });
}

const modelPolicy = {
  providers: { local: { type: "ollama" as const } },
  profiles: {
    "runtime-default": {
      provider: "local",
      model: "runtime-default:latest",
      contextWindowTokens: 32_000,
      supportsThinking: true,
      calibration: {
        "supervisor.decision": {},
        "supervisor.response": {},
        "planner.decision": {},
        "reviewer.decision": {},
        "worker.decision": {},
        "capability.controls": {},
        "tool_payload.raw": {},
      },
    },
  },
  defaults: {
    profileId: "runtime-default",
    steps: {
      [SUPERVISOR_DECISION_MODEL_STEP]: "supervisor.decision",
      [SUPERVISOR_RESPONSE_MODEL_STEP]: "supervisor.response",
      [PLANNER_DECISION_MODEL_STEP]: "planner.decision",
      [REVIEWER_DECISION_MODEL_STEP]: "reviewer.decision",
      [WORKER_DECISION_MODEL_STEP]: "worker.decision",
      [WORKER_RESULT_MODEL_STEP]: "supervisor.response",
      [CAPABILITY_CONTROLS_MODEL_STEP]: "capability.controls",
      [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: "toolPayload.raw",
    },
  },
};

function createRequest(
  invoke: ModelGatewayClient["invoke"],
  overrides: Partial<TestRequestSeed> = {},
): RequestExecutionScope {
  const scriptedInvoke = overrides.modelGatewayClient?.invoke ?? invoke;
  const pendingWorkerResults: string[] = [];
  const separatedInvoke: ModelGatewayClient["invoke"] = async (input) => {
    if (
      input.modelStep === SUPERVISOR_DECISION_MODEL_STEP &&
      typeof input.format === "object" &&
      input.format !== null &&
      "name" in input.format &&
      input.format.name === "supervisor_working_directory"
    ) {
      const frozenInvocation = (
        input.messages as readonly Readonly<{ content: string }>[]
      )
        .flatMap((message) => {
          try {
            const parsed = JSON.parse(message.content) as Record<
              string,
              unknown
            >;
            return parsed.kind === "runtime_supervisor_frozen_invocation_v1"
              ? [parsed]
              : [];
          } catch {
            return [];
          }
        })
        .at(-1);
      if (
        frozenInvocation?.roleId !== "planner" &&
        frozenInvocation?.roleId !== "worker"
      ) {
        throw new Error("supervisor_working_directory_fixture_invalid");
      }
      return {
        text: JSON.stringify({
          workingDirectory:
            frozenInvocation.roleId === "planner"
              ? PLANNER_WORKING_DIRECTORY
              : DIRECT_WORKER_WORKING_DIRECTORY,
        }),
        meta: {},
      };
    }
    if (input.modelStep === WORKER_RESULT_MODEL_STEP) {
      const result = pendingWorkerResults.shift();
      if (result === undefined) {
        throw new Error("worker_result_test_fixture_missing");
      }
      return { text: result, meta: {} };
    }
    const response = await scriptedInvoke(input);
    if (input.modelStep !== WORKER_DECISION_MODEL_STEP) {
      return response;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.text) as unknown;
    } catch {
      return response;
    }
    const decision =
      typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>).decision
        : undefined;
    if (
      typeof decision !== "object" ||
      decision === null ||
      Array.isArray(decision) ||
      (decision as Record<string, unknown>).action !== "return_result" ||
      typeof (decision as Record<string, unknown>).result !== "string"
    ) {
      return response;
    }
    pendingWorkerResults.push(
      (decision as Record<string, unknown>).result as string,
    );
    return {
      ...response,
      text: encodeDecision({ action: "return_result" }),
    };
  };
  return createTestRequestExecutionScope({
    requestId: "supervisor-runner-request",
    sessionId: "supervisor-runner-session",
    prompt: "What do you think?",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig,
    agentMode: "reasoning",
    modelPolicy,
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
    ...overrides,
    modelGatewayClient: {
      invoke: separatedInvoke,
      invokeRaw: overrides.modelGatewayClient?.invokeRaw ?? vi.fn(),
    },
  });
}

function readRuntimeChildResults(
  messages: readonly Readonly<{ role: string; content: string }>[],
): readonly Record<string, unknown>[] {
  return messages.flatMap((message) => {
    try {
      const parsed = JSON.parse(message.content) as unknown;
      return typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).kind === "runtime_child_result"
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Supervisor-root request runner slice", () => {
  test("keeps omitted and explicit supervisor-worker-v1 execution transcripts identical", async () => {
    async function run(
      explicit: boolean,
    ): Promise<Readonly<{ output: unknown; invocations: unknown }>> {
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (params) => ({
        text:
          params.modelStep === SUPERVISOR_RESPONSE_MODEL_STEP
            ? "One unchanged Supervisor response."
            : encodeDecision({
                action: "respond",
                acknowledgement: REQUEST_ACKNOWLEDGEMENT,
              }),
        meta: {},
      }));
      const request = createRequest(invoke, {
        ...(explicit
          ? {
              executionPolicySelection: Object.freeze({
                policy: "supervisor-worker-v1" as const,
                primaryProfileId: "runtime-default",
                source: "model_profile" as const,
              }),
            }
          : {}),
      });
      const output = await runRequestRunner(request);
      return Object.freeze({
        output,
        invocations: JSON.parse(JSON.stringify(invoke.mock.calls)),
      });
    }

    expect(await run(true)).toEqual(await run(false));
  });

  test("commits one direct Supervisor response without legacy profile routing", async () => {
    const getWorkerDescriptors = vi.fn(() =>
      Object.freeze([
        Object.freeze({
          capabilityId: "private_capability_identity",
          summary: "Inspect the current configured system state.",
          effect: "observation" as const,
          controls: Object.freeze({
            type: "object" as const,
            additionalProperties: false as const,
            properties: Object.freeze({}),
            required: Object.freeze([]),
          }),
        }),
      ]),
    );
    const getWorkerAdapters = vi.fn(() => Object.freeze([]));
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (params) => {
      params.onThinking?.("Thinking");
      if (params.modelStep === SUPERVISOR_RESPONSE_MODEL_STEP) {
        return {
          text: "One Supervisor owns the request.",
          meta: {},
        };
      }
      return {
        text: encodeDecision({
          action: "respond",
          acknowledgement: REQUEST_ACKNOWLEDGEMENT,
          title: "Supervisor ownership",
        }),
        meta: {},
      };
    });
    const onEvent = vi.fn<NonNullable<TestRequestSeed["onEvent"]>>();
    const request = createRequest(invoke, {
      workerCapabilityProvider: {
        getDescriptors: getWorkerDescriptors,
        getAdapters: getWorkerAdapters,
      },
      shouldGenerateSessionTitle: true,
      onEvent,
      historyMessages: [
        {
          id: "history-user",
          role: "user",
          content: "We are discussing one request owner.",
          createdAt: "2026-07-25T00:00:00.000Z",
          requestId: "earlier-request",
        },
        {
          id: "history-assistant",
          role: "assistant",
          content: "The Supervisor can be that owner.",
          createdAt: "2026-07-25T00:00:01.000Z",
          requestId: "earlier-request",
        },
      ],
    });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "One Supervisor owns the request.",
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        modelStep: SUPERVISOR_DECISION_MODEL_STEP,
        debugRequestId: request.requestId,
        format: expect.objectContaining({
          type: "json_schema",
          name: "supervisor_decision",
          strict: true,
        }),
        messages: [
          expect.objectContaining({ role: "system" }),
          {
            role: "user",
            content: "We are discussing one request owner.",
          },
          {
            role: "assistant",
            content: "The Supervisor can be that owner.",
          },
          expect.objectContaining({ role: "system" }),
          { role: "user", content: "What do you think?" },
        ],
      }),
    );
    expect(invoke.mock.calls[1]![0]).toMatchObject({
      modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
      debugRequestId: request.requestId,
    });
    expect(invoke.mock.calls[1]![0]).not.toHaveProperty("format");
    expect(getWorkerDescriptors).toHaveBeenCalledOnce();
    expect(getWorkerAdapters).not.toHaveBeenCalled();
    const supervisorSystemPrompt = (
      invoke.mock.calls[0]![0].messages as readonly Readonly<{
        role: string;
        content: string;
      }>[]
    ).find(({ role }) => role === "system")?.content;
    expect(supervisorSystemPrompt).not.toContain(
      "Inspect the current configured system state.",
    );
    expect(supervisorSystemPrompt).not.toContain("private_capability_identity");
    expect(request.onAcknowledgement).not.toHaveBeenCalled();
    expect(request.onSessionTitle).toHaveBeenCalledExactlyOnceWith(
      "Supervisor ownership",
    );
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
      "One Supervisor owns the request.",
    );
    expect(request.onThinkingDelta).toHaveBeenCalledWith("Thinking");
    expect(request.onThinkingTrace).toHaveBeenCalledWith({
      step: SUPERVISOR_DECISION_MODEL_STEP,
      status: "completed",
      text: "Thinking",
    });
    expect(
      onEvent.mock.calls.filter(([name]) => name !== "context.window.snapshot"),
    ).toEqual([]);
  });

  test("reconsiders a terminal decision when steering arrives before response commit", async () => {
    const requestSteering = createRequestSteeringInbox({
      requestId: "supervisor-runner-request",
    });
    let responseCount = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === SUPERVISOR_RESPONSE_MODEL_STEP) {
        responseCount += 1;
        if (responseCount === 1) {
          expect(
            requestSteering.append({
              steerId: "steer-before-final",
              text: "Please make the final answer shorter",
            }),
          ).toMatchObject({ ok: true, duplicate: false });
          return { text: "Superseded final response.", meta: {} };
        }
        return { text: "Updated final response.", meta: {} };
      }
      return {
        text: encodeDecision({
          action: "respond",
          acknowledgement: REQUEST_ACKNOWLEDGEMENT,
        }),
        meta: {},
      };
    });
    const onAcknowledgement = vi.fn();
    const request = createRequest(invoke, {
      requestSteering,
      onAcknowledgement,
    });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Updated final response.",
    });

    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    expect(onAcknowledgement).not.toHaveBeenCalled();
    const secondDecisionMessages = invoke.mock.calls[3]?.[0]?.messages as
      | readonly Readonly<{ role: string; content: string }>[]
      | undefined;
    const steeringMessage = secondDecisionMessages?.find((message) => {
      try {
        return (
          (JSON.parse(message.content) as Record<string, unknown>).kind ===
          REQUEST_STEERING_MESSAGE_KIND
        );
      } catch {
        return false;
      }
    });
    expect(steeringMessage).toBeDefined();
    expect(requestSteering.snapshot().version).toBe(1);
    expect(
      requestSteering.append({
        steerId: "steer-after-final",
        text: "This is too late",
      }),
    ).toEqual({ ok: false, reason: "request_not_active" });
  });

  test("defers steering received during Worker execution to the resumed Supervisor", async () => {
    const requestSteering = createRequestSteeringInbox({
      requestId: "supervisor-worker-steering-request",
    });
    let resolveWorker:
      | ((value: { text: string; meta: Record<string, unknown> }) => void)
      | undefined;
    const workerResponse = new Promise<{
      text: string;
      meta: Record<string, unknown>;
    }>((resolve) => {
      resolveWorker = resolve;
    });
    let supervisorDecisionCount = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === SUPERVISOR_DECISION_MODEL_STEP) {
        supervisorDecisionCount += 1;
        return {
          text: encodeDecision(
            supervisorDecisionCount === 1
              ? {
                  action: "invoke_role",
                  roleId: "worker",
                  objective: "Collect the bounded source material.",
                  acknowledgement: REQUEST_ACKNOWLEDGEMENT,
                }
              : { action: "respond" },
          ),
          meta: {},
        };
      }
      if (input.modelStep === WORKER_DECISION_MODEL_STEP) {
        return workerResponse;
      }
      if (input.modelStep === SUPERVISOR_RESPONSE_MODEL_STEP) {
        return { text: "I included the requested update.", meta: {} };
      }
      throw new Error(`unexpected model step ${input.modelStep}`);
    });
    const request = createRequest(invoke, { requestSteering });
    const resultPromise = runRequestRunner(request);

    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([input]) => input.modelStep === WORKER_DECISION_MODEL_STEP,
        ),
      ).toBe(true),
    );
    requestSteering.append({
      steerId: "steer-after-worker-start",
      text: "Also save the outcome in a dated file",
    });
    resolveWorker?.({
      text: encodeDecision({
        action: "return_result",
        result: "The bounded source material is ready.",
      }),
      meta: {},
    });

    await expect(resultPromise).resolves.toEqual({
      output: "I included the requested update.",
    });
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      WORKER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    const workerMessages = invoke.mock.calls[1]?.[0]?.messages as
      | readonly Readonly<{ role: string; content: string }>[]
      | undefined;
    expect(findSteeringMessage(workerMessages)).toBeUndefined();
    const resumedSupervisorMessages = invoke.mock.calls[2]?.[0]?.messages as
      | readonly Readonly<{ role: string; content: string }>[]
      | undefined;
    expect(findSteeringMessage(resumedSupervisorMessages)).toBeDefined();
  });

  test("binds the exact Gemma project scope only after frozen Planner routing", async () => {
    const plannerObjective = `Complete the existing project in ${PLANNER_WORKING_DIRECTORY}, including its implementation, connectivity, data, and functionality.`;
    const plannerResult = "The exact project outcome is complete.";
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      switch (invocationIndex) {
        case 1: {
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          const routing = {
            action: "invoke_role" as const,
            roleId: "planner" as const,
            objective: plannerObjective,
            acknowledgement: REQUEST_ACKNOWLEDGEMENT,
          };
          expect(routing).not.toHaveProperty("workingDirectory");
          return { text: encodeDecision(routing), meta: {} };
        }
        case 2: {
          expect(input.modelStep).toBe(PLANNER_DECISION_MODEL_STEP);
          const assignment = JSON.parse(
            (
              input.messages as readonly Readonly<{
                role: string;
                content: string;
              }>[]
            ).at(-1)!.content,
          ) as Record<string, unknown>;
          expect(assignment).toMatchObject({
            kind: "runtime_planner_assignment",
            objective: plannerObjective,
            workingDirectory: PLANNER_WORKING_DIRECTORY,
          });
          return {
            text: encodeDecision({
              action: "return_result",
              result: plannerResult,
            }),
            meta: {},
          };
        }
        case 3:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          return { text: encodeDecision({ action: "respond" }), meta: {} };
        case 4:
          expect(input.modelStep).toBe(SUPERVISOR_RESPONSE_MODEL_STEP);
          return { text: "The exact project outcome is complete.", meta: {} };
        default:
          throw new Error(`unexpected model invocation ${invocationIndex}`);
      }
    });
    const request = createRequest(invoke, {
      prompt: `Complete the existing project in ${PLANNER_WORKING_DIRECTORY} with all connected local artifacts.`,
    });
    const gatewayInvoke = vi.spyOn(request.modelGatewayClient, "invoke");

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "The exact project outcome is complete.",
    });

    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      PLANNER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    expect(gatewayInvoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      PLANNER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);

    const routingFormat = gatewayInvoke.mock.calls[0]![0].format;
    const workingDirectoryFormat = gatewayInvoke.mock.calls[1]![0].format;
    expect(routingFormat).toMatchObject({ name: "supervisor_decision" });
    expect(JSON.stringify(routingFormat)).not.toContain("workingDirectory");
    expect(workingDirectoryFormat).toMatchObject({
      name: "supervisor_working_directory",
      strict: true,
      schema: {
        type: "object",
        required: ["workingDirectory"],
        additionalProperties: false,
      },
    });
    const serializedWorkingDirectoryFormat = JSON.stringify(
      workingDirectoryFormat,
    );
    expect(serializedWorkingDirectoryFormat).not.toContain("roleId");
    expect(serializedWorkingDirectoryFormat).not.toContain("objective");
    expect(serializedWorkingDirectoryFormat).not.toContain(
      "workerCapabilityScope",
    );
    expect(serializedWorkingDirectoryFormat).not.toContain("catalogGroupIds");
    expect(
      Object.keys(
        (
          workingDirectoryFormat as {
            schema: { properties: Record<string, unknown> };
          }
        ).schema.properties,
      ),
    ).toEqual(["workingDirectory"]);

    const frozenInvocation = (
      gatewayInvoke.mock.calls[1]![0].messages as readonly Readonly<{
        content: string;
      }>[]
    ).flatMap((message) => {
      try {
        const parsed = JSON.parse(message.content) as Record<string, unknown>;
        return parsed.kind === "runtime_supervisor_frozen_invocation_v1"
          ? [parsed]
          : [];
      } catch {
        return [];
      }
    });
    expect(frozenInvocation).toEqual([
      {
        kind: "runtime_supervisor_frozen_invocation_v1",
        authority: "canonical_runtime_state",
        roleId: "planner",
        objective: plannerObjective,
      },
    ]);
  });

  test("does not open a stale child when steering arrives during title publication after phase two", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const requestSteering = createRequestSteeringInbox({
      requestId: "supervisor-steering-after-scope",
    });
    const onEvent = vi.fn(
      (_name: string, _payload?: Record<string, unknown>) => undefined,
    );
    const staleObjective = `Complete the stale project in ${PLANNER_WORKING_DIRECTORY}.`;
    let supervisorDecisionCount = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === SUPERVISOR_DECISION_MODEL_STEP) {
        supervisorDecisionCount += 1;
        if (supervisorDecisionCount === 1) {
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "planner",
              objective: staleObjective,
              acknowledgement: REQUEST_ACKNOWLEDGEMENT,
              title: "Stale project route",
            }),
            meta: {},
          };
        }
        expect(
          findSteeringMessage(
            input.messages as
              | readonly Readonly<{ role: string; content: string }>[]
              | undefined,
          ),
        ).toBeDefined();
        return { text: encodeDecision({ action: "respond" }), meta: {} };
      }
      if (input.modelStep === SUPERVISOR_RESPONSE_MODEL_STEP) {
        return { text: "The steered request was reconsidered.", meta: {} };
      }
      throw new Error(`stale child model step invoked: ${input.modelStep}`);
    });
    const onSessionTitle = vi.fn(async (title: string) => {
      expect(title).toBe("Stale project route");
      expect(
        requestSteering.append({
          steerId: "steer-during-title",
          text: "Do not open that project; reconsider the request.",
        }),
      ).toMatchObject({ ok: true, duplicate: false });
    });
    const request = createRequest(invoke, {
      requestId: "supervisor-steering-after-scope",
      requestSteering,
      shouldGenerateSessionTitle: true,
      onSessionTitle,
      onEvent,
    });
    const gatewayInvoke = vi.spyOn(request.modelGatewayClient, "invoke");

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "The steered request was reconsidered.",
    });

    expect(onSessionTitle).toHaveBeenCalledOnce();
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    expect(gatewayInvoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    expect(gatewayInvoke.mock.calls[1]![0].format).toMatchObject({
      name: "supervisor_working_directory",
    });
    expect(
      onEvent.mock.calls.some(
        ([name, payload]) =>
          name === "runtime.state" && payload?.stage === "planner",
      ),
    ).toBe(false);
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.supervisor_root",
          event: "invocation.superseded",
          decisionSteeringVersion: 0,
          currentSteeringVersion: 1,
          phase: "before_invoke_child",
        }),
      ]),
    );
  });

  test("runs generic Planner -> Worker -> same Planner before returning to Supervisor", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const plannerObjective =
      "Coordinate one bounded implementation outcome and report its evidence.";
    const workerObjective =
      "Produce the bounded implementation outcome and report exact evidence.";
    const workerResult = "The bounded implementation outcome is complete.";
    const plannerResult =
      "The requested outcome is complete with the reported evidence.";
    const onEvent = vi.fn(
      (_name: string, _payload?: Record<string, unknown>) => undefined,
    );
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      switch (invocationIndex) {
        case 1:
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "planner",
              objective: plannerObjective,
              acknowledgement: REQUEST_ACKNOWLEDGEMENT,
            }),
            meta: {},
          };
        case 2:
          expect(input.modelStep).toBe(PLANNER_DECISION_MODEL_STEP);
          expect(
            JSON.parse(
              (input.messages as readonly Readonly<{
                role: string;
                content: string;
              }>[])!.at(-1)!.content,
            ),
          ).toMatchObject({
            kind: "runtime_planner_assignment",
            workingDirectory: PLANNER_WORKING_DIRECTORY,
          });
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "worker",
              plan: {
                summary: plannerObjective,
                items: [
                  {
                    title: "Produce bounded outcome",
                    objective: workerObjective,
                  },
                ],
              },
              selectedItemIndexes: [0],
            }),
            meta: {},
          };
        case 3:
          expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "return_result",
              result: workerResult,
            }),
            meta: {},
          };
        case 4: {
          expect(input.modelStep).toBe(PLANNER_DECISION_MODEL_STEP);
          const messages = input.messages as readonly Readonly<{
            role: string;
            content: string;
          }>[];
          expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({
            kind: "runtime_child_result",
            callerCallId: "call-2",
            childCallId: "call-3",
            resultRef: "result-1",
            roleId: "worker",
            delegatedObjective: workerObjective,
            workingDirectory: PLANNER_WORKING_DIRECTORY,
            dependencyResultRefs: [],
            outcome: "completed",
            summary: workerResult,
          });
          return {
            text: encodeDecision({
              action: "return_result",
              result: plannerResult,
            }),
            meta: {},
          };
        }
        case 5:
          return {
            text: encodeDecision({ action: "respond" }),
            meta: {},
          };
        case 6:
          return {
            text: "The delegated work is complete.",
            meta: {},
          };
        default:
          throw new Error(`unexpected model invocation ${invocationIndex}`);
      }
    });
    const request = createRequest(invoke, { onEvent });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "The delegated work is complete.",
    });

    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      PLANNER_DECISION_MODEL_STEP,
      WORKER_DECISION_MODEL_STEP,
      PLANNER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
      "The delegated work is complete.",
    );
    expect(request.onAcknowledgement).toHaveBeenCalledExactlyOnceWith(
      REQUEST_ACKNOWLEDGEMENT,
    );
    expect(
      onEvent.mock.calls.filter(([name]) => name !== "context.window.snapshot"),
    ).toEqual([
      [
        "runtime.state",
        {
          stage: "planner",
          phase: "planning",
          message: "Planning the delegated work...",
        },
      ],
      [
        "planner.plan.created",
        {
          stage: "development_plan",
          phase: "created",
          plan: {
            summary: plannerObjective,
            total: 1,
            completed: 0,
            blocked: 0,
            pending: 0,
            inProgress: 1,
            items: [
              {
                id: "plan-call-2-item-1",
                title: "Produce bounded outcome",
                status: "in_progress",
                order: 1,
                total: 1,
              },
            ],
          },
        },
      ],
      [
        "planner.plan.item.started",
        {
          stage: "development_plan",
          phase: "created",
          item: {
            id: "plan-call-2-item-1",
            title: "Produce bounded outcome",
            status: "in_progress",
            order: 1,
            total: 1,
          },
          planItemOrder: 1,
          planItemTotal: 1,
          planSummary: plannerObjective,
          planTotal: 1,
          planCompleted: 0,
        },
      ],
      [
        "runtime.state",
        {
          stage: "worker",
          phase: "working",
          message: "Working on the delegated task...",
        },
      ],
      [
        "planner.plan.updated",
        {
          stage: "development_plan",
          phase: "updated",
          plan: {
            summary: plannerObjective,
            total: 1,
            completed: 1,
            blocked: 0,
            pending: 0,
            inProgress: 0,
            items: [
              {
                id: "plan-call-2-item-1",
                title: "Produce bounded outcome",
                status: "done",
                order: 1,
                total: 1,
              },
            ],
          },
        },
      ],
      [
        "planner.plan.item.completed",
        {
          stage: "development_plan",
          phase: "updated",
          item: {
            id: "plan-call-2-item-1",
            title: "Produce bounded outcome",
            status: "done",
            order: 1,
            total: 1,
          },
          planItemOrder: 1,
          planItemTotal: 1,
          planSummary: plannerObjective,
          planTotal: 1,
          planCompleted: 1,
        },
      ],
      [
        "runtime.state",
        {
          stage: "planner",
          phase: "planning",
          message: "Planning the delegated work...",
        },
      ],
      [
        "runtime.state",
        {
          stage: "supervisor",
          phase: "resuming",
          message: "Processing the delegated result...",
        },
      ],
    ]);

    const resumedSupervisorInvocation = invoke.mock.calls[4]![0];
    const resumedSupervisorMessages =
      resumedSupervisorInvocation.messages as Array<{
        role: string;
        content: string;
      }>;
    expect(JSON.parse(resumedSupervisorMessages.at(-1)!.content)).toMatchObject({
      kind: "runtime_child_result",
      callerCallId: "call-1",
      childCallId: "call-2",
      resultRef: "result-2",
      roleId: "planner",
      outcome: "completed",
      summary: plannerResult,
    });

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.supervisor",
          event: "decision.accepted",
          decisionPhase: "routing",
          selectedAction: "invoke_role",
          selectedRoleId: "planner",
          workingDirectoryIncluded: false,
          workingDirectoryLength: 0,
        }),
        expect.objectContaining({
          scope: "runtime.supervisor",
          event: "working_directory.accepted",
          decisionPhase: "working_directory",
          workingDirectoryIncluded: true,
          workingDirectoryLength: PLANNER_WORKING_DIRECTORY.length,
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "child.requested",
          roleId: "planner",
          childRoleId: "worker",
          fromActivation: 1,
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.continued",
          continuationKind: "role_child",
          roleId: "planner",
          childCallId: "call-3",
          resultRef: "result-1",
          fromActivation: 1,
          toActivation: 2,
        }),
        expect.objectContaining({
          scope: "runtime.planner",
          event: "child_results.projected",
          callId: "call-2",
          returnedChildCallId: "call-3",
          returnedResultRef: "result-1",
        }),
      ]),
    );
    const serializedEvidence = JSON.stringify(logs);
    expect(serializedEvidence).not.toContain(plannerObjective);
    expect(serializedEvidence).not.toContain(workerObjective);
    expect(serializedEvidence).not.toContain(workerResult);
    expect(serializedEvidence).not.toContain(plannerResult);
    expect(serializedEvidence).not.toContain(PLANNER_WORKING_DIRECTORY);
    expect(serializedEvidence).not.toContain("development_loop");
    expect(serializedEvidence).not.toContain("tool_loop");
    expect(serializedEvidence).not.toContain(
      "runtime.compatibility.planner_child",
    );
  });

  test("retains a direct Supervisor Worker scope and filters the Worker binding", async () => {
    const invoke = vi
      .fn<ModelGatewayClient["invoke"]>()
      .mockResolvedValueOnce({
        text: encodeDecision({
          action: "invoke_role",
          roleId: "worker",
          objective:
            "Explain one concrete benefit of small implementation checkpoints.",
          workerCapabilityScope: { catalogGroupIds: ["observe"] },
          acknowledgement: REQUEST_ACKNOWLEDGEMENT,
        }),
        meta: {},
      })
      .mockResolvedValueOnce({
        text: encodeDecision({
          action: "return_result",
          result:
            "They localize the first failing change for faster debugging.",
        }),
        meta: {},
      })
      .mockResolvedValueOnce({
        text: encodeDecision({
          action: "respond",
        }),
        meta: {},
      })
      .mockResolvedValueOnce({
        text: "Small checkpoints make failures easier to localize.",
        meta: {},
      });
    const workerDescriptors = Object.freeze([
      Object.freeze({
        capabilityId: "inspect_system_state",
        summary: "Inspect current system state.",
        effect: "observation" as const,
        catalogGroups: Object.freeze(["observe"]),
        controls: Object.freeze({
          type: "object" as const,
          properties: Object.freeze({}),
          required: Object.freeze([]),
          additionalProperties: false as const,
        }),
      }),
      Object.freeze({
        capabilityId: "mutate_system_state",
        summary: "Apply one bounded system state change.",
        effect: "mutation" as const,
        catalogGroups: Object.freeze(["write"]),
        controls: Object.freeze({
          type: "object" as const,
          properties: Object.freeze({}),
          required: Object.freeze([]),
          additionalProperties: false as const,
        }),
      }),
    ]);
    const executeCapability = vi.fn(async () => ({
      outcome: "failed" as const,
      observedEffect: "none" as const,
      summary: "This adapter is not expected to execute.",
      failureOutcomeFingerprint: "unexpected_test_execution",
    }));
    const workerAdapters = Object.freeze(
      workerDescriptors.map((descriptor) =>
        Object.freeze({ descriptor, execute: executeCapability }),
      ),
    );
    const getWorkerDescriptors = vi.fn(() => workerDescriptors);
    const getWorkerAdapters = vi.fn(() => workerAdapters);
    const onEvent = vi.fn<NonNullable<TestRequestSeed["onEvent"]>>();
    const baseRequest = createRequest(invoke, { onEvent });
    const request = createTestRequestExecutionScope({
      ...baseRequest,
      workerCapabilityProvider: Object.freeze({
        getDescriptors: getWorkerDescriptors,
        getAdapters: getWorkerAdapters,
      }),
    });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Small checkpoints make failures easier to localize.",
    });

    expect(invoke).toHaveBeenCalledTimes(4);
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      WORKER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    const supervisorMessages = invoke.mock.calls[0]![0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(supervisorMessages[0]!.content).not.toContain(
      "inspect_system_state",
    );
    expect(supervisorMessages[0]!.content).not.toContain("mutate_system_state");
    const workerInvocation = invoke.mock.calls[1]![0];
    expect(workerInvocation).toMatchObject({
      modelStep: WORKER_DECISION_MODEL_STEP,
      format: {
        type: "json_schema",
        name: "worker_decision",
        strict: true,
      },
    });
    const workerMessages = workerInvocation.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(workerMessages).toHaveLength(3);
    expect(JSON.parse(workerMessages[1]!.content)).toEqual({
      kind: "runtime_request_source_v1",
      authority: "reference_data",
      sourceRef: "request:supervisor-runner-request",
      currentRequest: "What do you think?",
    });
    const workerAssignment = JSON.parse(workerMessages[2]!.content) as Record<
      string,
      unknown
    >;
    expect(workerAssignment).toMatchObject({
      kind: "runtime_worker_assignment",
      callId: "call-2",
      parentCallId: "call-1",
      depth: 1,
      invocationAttempt: 1,
      workingDirectory: DIRECT_WORKER_WORKING_DIRECTORY,
      objective:
        "Explain one concrete benefit of small implementation checkpoints.",
      capabilitiesAvailable: true,
      availableCapabilities: [
        {
          capabilityId: "inspect_system_state",
        },
      ],
      availableChildRoleIds: [],
    });
    expect(
      (
        workerAssignment.availableCapabilities as Array<{
          capabilityId: string;
        }>
      ).map(({ capabilityId }) => capabilityId),
    ).toEqual(["inspect_system_state"]);

    const resumedInvocation = invoke.mock.calls[2]![0];
    const resumedMessages = resumedInvocation.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(resumedMessages.slice(-3).map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(resumedMessages.at(-3)).toEqual({
      role: "user",
      content: "What do you think?",
    });
    expect(JSON.parse(resumedMessages.at(-2)!.content)).toEqual({
      action: "invoke_role",
      roleId: "worker",
      objective:
        "Explain one concrete benefit of small implementation checkpoints.",
      workingDirectory: DIRECT_WORKER_WORKING_DIRECTORY,
      workerCapabilityScope: { catalogGroupIds: ["observe"] },
    });
    expect(JSON.parse(resumedMessages.at(-1)!.content)).toMatchObject({
      kind: "runtime_child_result",
      callerCallId: "call-1",
      childCallId: "call-2",
      resultRef: "result-1",
      roleId: "worker",
      outcome: "completed",
      summary: "They localize the first failing change for faster debugging.",
    });
    expect(getWorkerDescriptors).toHaveBeenCalledOnce();
    expect(getWorkerAdapters).toHaveBeenCalledOnce();
    expect(executeCapability).not.toHaveBeenCalled();
    expect(
      onEvent.mock.calls.filter(([name]) => name === "runtime.state"),
    ).toEqual([
      [
        "runtime.state",
        {
          stage: "worker",
          phase: "working",
          message: "Working on the delegated task...",
        },
      ],
      [
        "runtime.state",
        {
          stage: "supervisor",
          phase: "resuming",
          message: "Processing the delegated result...",
        },
      ],
    ]);
  });

  test("lets one Supervisor invoke two direct roles before responding with both results", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const workerObjective =
      "Inspect the bounded input and report one concrete finding.";
    const plannerObjective =
      "Combine the concrete finding into one bounded recommendation.";
    const workerResult = "The bounded input contains one actionable signal.";
    const plannerResult =
      "The recommendation incorporates the reported actionable signal.";
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      switch (invocationIndex) {
        case 1:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "worker",
              objective: workerObjective,
              acknowledgement: REQUEST_ACKNOWLEDGEMENT,
            }),
            meta: {},
          };
        case 2:
          expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "return_result",
              result: workerResult,
            }),
            meta: {},
          };
        case 3:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          expect(readRuntimeChildResults(messages)).toMatchObject([
            {
              kind: "runtime_child_result",
              callerCallId: "call-1",
              childCallId: "call-2",
              resultRef: "result-1",
              roleId: "worker",
              outcome: "completed",
              summary: workerResult,
            },
          ]);
          expect(JSON.stringify(input.format)).toContain('"planner"');
          expect(JSON.stringify(input.format)).toContain('"worker"');
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "planner",
              objective: plannerObjective,
            }),
            meta: {},
          };
        case 4:
          expect(input.modelStep).toBe(PLANNER_DECISION_MODEL_STEP);
          expect(JSON.parse(messages[1]!.content)).toEqual({
            kind: "runtime_request_source_v1",
            authority: "reference_data",
            sourceRef: "request:supervisor-runner-request",
            currentRequest: "What do you think?",
          });
          expect(JSON.parse(messages[2]!.content)).toMatchObject({
            kind: "runtime_planner_assignment",
            callId: "call-3",
            parentCallId: "call-1",
            objective: plannerObjective,
            dependencyResults: [
              {
                resultRef: "result-1",
                producerCallId: "call-2",
                roleId: "worker",
                outcome: "completed",
                summary: workerResult,
              },
            ],
          });
          expect(messages[0]!.content).toContain(
            "automatically supplied from a previously settled direct sibling",
          );
          return {
            text: encodeDecision({
              action: "return_result",
              result: plannerResult,
            }),
            meta: {},
          };
        case 5:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          expect(readRuntimeChildResults(messages)).toMatchObject([
            {
              kind: "runtime_child_result",
              callerCallId: "call-1",
              childCallId: "call-2",
              resultRef: "result-1",
              roleId: "worker",
              outcome: "completed",
              summary: workerResult,
            },
            {
              kind: "runtime_child_result",
              callerCallId: "call-1",
              childCallId: "call-3",
              resultRef: "result-2",
              roleId: "planner",
              outcome: "completed",
              summary: plannerResult,
            },
          ]);
          return {
            text: encodeDecision({ action: "respond" }),
            meta: {},
          };
        case 6:
          expect(input.modelStep).toBe(SUPERVISOR_RESPONSE_MODEL_STEP);
          expect(readRuntimeChildResults(messages)).toHaveLength(2);
          return {
            text: "Both delegated results were incorporated.",
            meta: {},
          };
        default:
          throw new Error(`unexpected model invocation ${invocationIndex}`);
      }
    });
    const onEvent = vi.fn(
      (_name: string, _payload?: Record<string, unknown>) => undefined,
    );
    const request = createRequest(invoke, { onEvent });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Both delegated results were incorporated.",
    });

    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      WORKER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      PLANNER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    expect(
      onEvent.mock.calls
        .filter(([name]) => name === "runtime.state")
        .map(([, payload]) => [payload?.stage, payload?.phase]),
    ).toEqual([
      ["worker", "working"],
      ["supervisor", "resuming"],
      ["planner", "planning"],
      ["supervisor", "resuming"],
    ]);
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(
      logs
        .filter(
          (entry) =>
            entry.scope === "runtime.supervisor_root" &&
            entry.event === "activation.started",
        )
        .map((entry) => ({
          invocationAttempt: entry.invocationAttempt,
          completedDirectChildCount: entry.completedDirectChildCount,
          remainingCallSlots: entry.remainingCallSlots,
          allowedRoleIds: entry.allowedRoleIds,
        })),
    ).toEqual([
      {
        invocationAttempt: 1,
        completedDirectChildCount: 0,
        remainingCallSlots: 47,
        allowedRoleIds: ["planner", "worker", "reviewer"],
      },
      {
        invocationAttempt: 2,
        completedDirectChildCount: 1,
        remainingCallSlots: 46,
        allowedRoleIds: ["planner", "worker", "reviewer"],
      },
      {
        invocationAttempt: 3,
        completedDirectChildCount: 2,
        remainingCallSlots: 45,
        allowedRoleIds: ["planner", "worker", "reviewer"],
      },
    ]);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(workerObjective);
    expect(serializedLogs).not.toContain(plannerObjective);
    expect(serializedLogs).not.toContain(workerResult);
    expect(serializedLogs).not.toContain(plannerResult);
  });

  test("lets the Supervisor choose recovery after a failed child", async () => {
    const failedObjective =
      "Attempt the bounded task and report failure truthfully.";
    const failure = "The bounded task could not be completed.";
    const recoveryObjective =
      "Produce a revised bounded approach using the reported failure.";
    const recovered =
      "The revised bounded approach is ready for the Supervisor.";
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      switch (invocationIndex) {
        case 1:
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "worker",
              objective: failedObjective,
              acknowledgement: REQUEST_ACKNOWLEDGEMENT,
            }),
            meta: {},
          };
        case 2:
          expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "return_failure",
              reason: failure,
            }),
            meta: {},
          };
        case 3:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          expect(readRuntimeChildResults(messages)).toMatchObject([
            {
              childCallId: "call-2",
              resultRef: "result-1",
              roleId: "worker",
              outcome: "failed",
              summary: failure,
            },
          ]);
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "planner",
              objective: recoveryObjective,
            }),
            meta: {},
          };
        case 4:
          expect(input.modelStep).toBe(PLANNER_DECISION_MODEL_STEP);
          expect(JSON.parse(messages[2]!.content)).toMatchObject({
            kind: "runtime_planner_assignment",
            callId: "call-3",
            parentCallId: "call-1",
            objective: recoveryObjective,
            dependencyResults: [
              {
                resultRef: "result-1",
                producerCallId: "call-2",
                roleId: "worker",
                outcome: "failed",
                summary: failure,
              },
            ],
          });
          return {
            text: encodeDecision({
              action: "return_result",
              result: recovered,
            }),
            meta: {},
          };
        case 5:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          expect(
            readRuntimeChildResults(messages).map((result) => ({
              childCallId: result.childCallId,
              resultRef: result.resultRef,
              roleId: result.roleId,
              outcome: result.outcome,
            })),
          ).toEqual([
            {
              childCallId: "call-2",
              resultRef: "result-1",
              roleId: "worker",
              outcome: "failed",
            },
            {
              childCallId: "call-3",
              resultRef: "result-2",
              roleId: "planner",
              outcome: "completed",
            },
          ]);
          return {
            text: encodeDecision({ action: "respond" }),
            meta: {},
          };
        case 6:
          expect(input.modelStep).toBe(SUPERVISOR_RESPONSE_MODEL_STEP);
          expect(
            readRuntimeChildResults(messages).map((result) => result.outcome),
          ).toEqual(["failed", "completed"]);
          return {
            text: "The revised approach is ready.",
            meta: {},
          };
        default:
          throw new Error(`unexpected model invocation ${invocationIndex}`);
      }
    });
    const request = createRequest(invoke);

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "The revised approach is ready.",
    });

    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      WORKER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      PLANNER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
      "The revised approach is ready.",
    );
  });

  test("keeps an exact observation handoff across a later child without one", async () => {
    const scenario = await runObservationHandoffScenario();

    expect(scenario.result).toEqual({
      output: "The exact delegated results were incorporated.",
      finalObservation: scenario.workerObservation,
    });
    expect(readObservationHandoffLogs(scenario.logs)).toEqual([
      expect.objectContaining({
        rootCallId: "call-1",
        callId: "call-1",
        childCallId: "call-2",
        resultRef: "result-1",
        replaced: false,
        observationContentLength:
          scenario.workerObservation.observationContent.length,
      }),
    ]);
    expect(JSON.stringify(scenario.logs)).not.toContain(
      scenario.workerObservation.observationContent,
    );
  });

  test("replaces an observation handoff only with a later exact direct-child handoff", async () => {
    const plannerObservation = createObservation("planner-observation");
    const scenario = await runObservationHandoffScenario(plannerObservation);

    expect(scenario.result).toEqual({
      output: "The exact delegated results were incorporated.",
      finalObservation: plannerObservation,
    });
    expect(readObservationHandoffLogs(scenario.logs)).toEqual([
      expect.objectContaining({
        childCallId: "call-2",
        resultRef: "result-1",
        replaced: false,
      }),
      expect.objectContaining({
        childCallId: "call-3",
        resultRef: "result-2",
        replaced: true,
        observationContentLength: plannerObservation.observationContent.length,
      }),
    ]);
    expect(JSON.stringify(scenario.logs)).not.toContain(
      plannerObservation.observationContent,
    );
  });

  test("rejects another direct child when the canonical call budget is full", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    let supervisorDecisionCount = 0;
    let workerDecisionCount = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === SUPERVISOR_DECISION_MODEL_STEP) {
        supervisorDecisionCount += 1;
        return {
          text: encodeDecision({
            action: "invoke_role",
            roleId: "worker",
            objective: `Execute bounded child ${supervisorDecisionCount}.`,
            ...(supervisorDecisionCount === 1
              ? { acknowledgement: REQUEST_ACKNOWLEDGEMENT }
              : {}),
          }),
          meta: {},
        };
      }
      if (input.modelStep === WORKER_DECISION_MODEL_STEP) {
        workerDecisionCount += 1;
        return {
          text: encodeDecision({
            action: "return_result",
            result: `Bounded child ${workerDecisionCount} completed.`,
          }),
          meta: {},
        };
      }
      throw new Error(`unexpected model step ${input.modelStep}`);
    });
    const request = createRequest(invoke, {
      modelPolicy: {
        ...modelPolicy,
        profiles: {
          ...modelPolicy.profiles,
          "runtime-default": {
            ...modelPolicy.profiles["runtime-default"],
            contextWindowTokens: 128_000,
          },
        },
      },
    });

    await expect(runRequestRunner(request)).rejects.toThrow(
      "role_executor_child_invocation_invalid:supervisor:call_limit_exceeded",
    );

    expect(supervisorDecisionCount).toBe(48);
    expect(workerDecisionCount).toBe(47);
    expect(
      invoke.mock.calls.some(
        ([input]) => input.modelStep === SUPERVISOR_RESPONSE_MODEL_STEP,
      ),
    ).toBe(false);
    expect(request.onAnswerToken).not.toHaveBeenCalled();
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_calls",
          event: "transition.rejected",
          commandType: "open_child",
          rejectionCode: "call_limit_exceeded",
          callCount: 48,
          maxCalls: 48,
          maxCapabilityExecutions: 96,
        }),
        expect.objectContaining({
          scope: "runtime.supervisor_root",
          event: "activation.failed",
          invocationAttempt: 48,
          completedDirectChildCount: 47,
          remainingCallSlots: 0,
          failureStage: "invoke_child",
          errorType: "Error",
        }),
      ]),
    );
  });

  test("returns one exact Worker capability result through the central role turn engine", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const observation = "SYSTEM_STATE_7_4";
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      switch (invocationIndex) {
        case 1:
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "worker",
              objective: "Inspect the current system state and report it.",
              workerCapabilityScope: { catalogGroupIds: ["other"] },
              acknowledgement: REQUEST_ACKNOWLEDGEMENT,
            }),
            meta: {},
          };
        case 2:
          return {
            text: encodeDecision({
              action: "invoke_capability",
              capabilityId: "inspect_system_state",
              intent: "Inspect the current system state.",
            }),
            meta: {},
          };
        case 3:
          return {
            text: encodeDecision({
              action: "invoke_capability",
              controls: {},
            }),
            meta: {},
          };
        case 4: {
          const messages = input.messages as readonly Readonly<{
            role: string;
            content: string;
          }>[];
          expect(JSON.parse(messages[2]!.content)).toMatchObject({
            kind: "runtime_worker_assignment",
          });
          expect(JSON.parse(messages[3]!.content)).toMatchObject({
            kind: "runtime_request_tool_results_v1",
            authority: "reference_data",
            results: [
              {
                executionId: "capability-execution-1",
                capabilityId: "inspect_system_state",
                outcome: "succeeded",
                observedEffect: "observation",
                summary: observation,
              },
            ],
          });
          return {
            text: encodeDecision({
              action: "return_result",
              result: `Consumed canonical observation: ${observation}`,
            }),
            meta: {},
          };
        }
        case 5:
          return {
            text: encodeDecision({ action: "respond" }),
            meta: {},
          };
        case 6:
          return {
            text: `Current system state: ${observation}`,
            meta: {},
          };
        default:
          throw new Error(`unexpected model invocation ${invocationIndex}`);
      }
    });
    const listNormalInvocations = vi.fn(() => [systemStateRegistration()]);
    const expectedAvailableTools = [
      {
        toolName: "system_probe",
        operationId: "inspect_system_state",
        summary: "Inspect current system state.",
        catalogGroups: ["other"],
        effect: "read_only",
      },
    ];
    const prepareSharedState = vi.fn((state = {}) => ({
      ...state,
      preparedForWorker: true,
    }));
    const executeTool = vi.fn(async () =>
      systemStateExecutionResult(observation),
    );
    const onEvent = vi.fn(
      (_name: string, _payload?: Record<string, unknown>) => undefined,
    );
    const toolRegistry = createToolRegistry({
      listNormalInvocations,
      prepareSharedState,
      execute: executeTool,
    });
    const baseRequest = createRequest(invoke, {
      runnerConfig: capabilityRunnerConfig,
      onEvent,
    });
    const request = createTestRequestExecutionScopeWithCapabilities(
      baseRequest,
      (request) =>
        createRequestWorkerCapabilityProvider({
          request,
          executionPolicyAuthority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
          toolRegistryOverride: toolRegistry,
        }),
    );

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: `Current system state: ${observation}`,
    });

    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      WORKER_DECISION_MODEL_STEP,
      CAPABILITY_CONTROLS_MODEL_STEP,
      WORKER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    expect(listNormalInvocations).toHaveBeenCalledOnce();
    expect(prepareSharedState).toHaveBeenCalledExactlyOnceWith({
      availableTools: expectedAvailableTools,
      currentSessionId: request.sessionId,
      requestContext: {
        agentMode: request.agentMode,
        toolPermissionMode: request.toolPermissionMode,
      },
    });
    expect(executeTool).toHaveBeenCalledExactlyOnceWith(
      { tool: "system_probe", params: {} },
      expect.objectContaining({
        abortSignal: request.abortSignal,
        sharedState: {
          availableTools: expectedAvailableTools,
          currentSessionId: request.sessionId,
          requestContext: {
            agentMode: request.agentMode,
            toolPermissionMode: request.toolPermissionMode,
          },
          preparedForWorker: true,
        },
      }),
    );
    const lifecycleEvents = onEvent.mock.calls.filter(
      ([name]) => name !== "context.window.snapshot",
    );
    expect(lifecycleEvents.map(([name]) => name)).toEqual([
      "runtime.state",
      "tool.started",
      "tool.completed",
      "runtime.state",
      "runtime.state",
    ]);
    expect(
      lifecycleEvents.map(([name, payload]) => ({
        name,
        stage: payload?.stage,
        phase: payload?.phase,
      })),
    ).toEqual([
      { name: "runtime.state", stage: "worker", phase: "working" },
      { name: "tool.started", stage: undefined, phase: undefined },
      { name: "tool.completed", stage: undefined, phase: undefined },
      { name: "runtime.state", stage: "worker", phase: "working" },
      { name: "runtime.state", stage: "supervisor", phase: "resuming" },
    ]);
    expect(request.onAcknowledgement).toHaveBeenCalledExactlyOnceWith(
      REQUEST_ACKNOWLEDGEMENT,
    );
    expect(request.onThinkingDelta).toHaveBeenCalledExactlyOnceWith(
      "Inspect the current system state.\n\n",
    );

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    const begun = logs.filter(
      (entry) =>
        entry.scope === "runtime.role_calls" &&
        entry.event === "capability.execution_begun",
    );
    const settled = logs.filter(
      (entry) =>
        entry.scope === "runtime.role_calls" &&
        entry.event === "capability.execution_settled",
    );
    expect(begun).toEqual([
      expect.objectContaining({
        executionId: "capability-execution-1",
        callId: "call-2",
        invocationAttempt: 1,
        capabilityId: "inspect_system_state",
      }),
    ]);
    expect(settled).toEqual([
      expect.objectContaining({
        executionId: "capability-execution-1",
        callId: "call-2",
        outcome: "succeeded",
        observedEffect: "observation",
      }),
    ]);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.continued",
          roleId: "worker",
          executionId: "capability-execution-1",
          fromActivation: 1,
          toActivation: 2,
          turnCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.role_executors",
          event: "executor.completed",
          roleId: "worker",
          activationCount: 2,
          turnCount: 2,
        }),
      ]),
    );
    const serializedEvidence = JSON.stringify({
      logs,
      events: onEvent.mock.calls,
    });
    expect(serializedEvidence).not.toContain("development_loop");
    expect(serializedEvidence).not.toContain("tool_loop");
    expect(serializedEvidence).not.toContain(
      "runtime.compatibility.planner_child",
    );
  });

  test("creates one exact file through the real generic Worker mutation path", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const hostRoot = await mkdtemp(
      join(tmpdir(), "supervisor-worker-mutation-"),
    );
    const agentWorkDir = join(hostRoot, "agent-work");
    await mkdir(agentWorkDir);
    const logicalTarget = "gate-c/artifact.txt";
    const physicalTarget = join(agentWorkDir, logicalTarget);
    const body = "Gate C real mutation.\n";
    const objective =
      `Create a new file at ${logicalTarget} containing exactly: ` +
      JSON.stringify(body);
    const authoringObjective =
      `Author the complete contents of ${logicalTarget} with exactly: ` +
      JSON.stringify(body);
    const runtimeConfig = createMutationRuntimeConfig(hostRoot, agentWorkDir);
    const toolRegistry = createDefaultToolRegistry(runtimeConfig);
    const listNormalInvocations = vi.spyOn(
      toolRegistry,
      "listNormalInvocations",
    );
    const executeTool = vi.spyOn(toolRegistry, "execute");
    const onEvent = vi.fn(
      (_name: string, _payload?: Record<string, unknown>) => undefined,
    );
    const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      switch (invocationIndex) {
        case 1:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "worker",
              objective,
              workerCapabilityScope: { catalogGroupIds: ["write"] },
              acknowledgement: REQUEST_ACKNOWLEDGEMENT,
            }),
            meta: {},
          };
        case 2:
          expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "invoke_capability",
              capabilityId: "write_complete_file",
              intent: "Create the exact requested file.",
              authoringObjective,
              selectionControls: { path: logicalTarget },
            }),
            meta: {},
          };
        case 3: {
          expect(input.modelStep).toBe(
            WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
          );
          expect(input).not.toHaveProperty("format");
          const messages = input.messages as readonly Readonly<{
            role: string;
            content: string;
          }>[];
          const prefix = "Canonical runtime context:\n";
          expect(messages).toHaveLength(3);
          expect(JSON.parse(messages[1]!.content)).toEqual({
            kind: "runtime_request_source_v1",
            authority: "reference_data",
            sourceRef: "request:supervisor-runner-request",
            currentRequest: `Please create ${logicalTarget} with the requested text.`,
          });
          expect(messages[2]!.content.startsWith(prefix)).toBe(true);
          const payloadContext = JSON.parse(
            messages[2]!.content.slice(prefix.length),
          );
          expect(payloadContext).toMatchObject({
            worker: {
              callId: "call-2",
              parentCallId: "call-1",
              invocationAttempt: 1,
              objective,
            },
            acceptedCapability: {
              capabilityId: "write_complete_file",
              authoringObjective,
              controls: { path: logicalTarget },
            },
            payloadContract: {
              maxBytes: 1_048_576,
            },
          });
          expect(payloadContext).not.toHaveProperty(
            "acceptedCapability.intent",
          );
          return { text: body, meta: {} };
        }
        case 4: {
          expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
          const messages = input.messages as readonly Readonly<{
            role: string;
            content: string;
          }>[];
          expect(JSON.parse(messages[2]!.content)).toMatchObject({
            kind: "runtime_worker_assignment",
          });
          expect(JSON.parse(messages[3]!.content)).toMatchObject({
            kind: "runtime_request_tool_results_v1",
            authority: "reference_data",
            results: [
              {
                executionId: "capability-execution-1",
                capabilityId: "write_complete_file",
                declaredEffect: "mutation",
                outcome: "succeeded",
                observedEffect: "mutation",
              },
            ],
          });
          return {
            text: encodeDecision({
              action: "return_result",
              result: "The requested file was created.",
            }),
            meta: {},
          };
        }
        case 5:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({ action: "respond" }),
            meta: {},
          };
        case 6:
          expect(input.modelStep).toBe(SUPERVISOR_RESPONSE_MODEL_STEP);
          return {
            text: "The requested file was created.",
            meta: {},
          };
        default:
          throw new Error(`unexpected model invocation ${invocationIndex}`);
      }
    });

    try {
      const baseRequest = createRequest(invoke, {
        prompt: `Please create ${logicalTarget} with the requested text.`,
        runnerConfig: mutationRunnerConfig,
        modelGatewayClient: { invoke, invokeRaw },
        onEvent,
      });
      const request = createTestRequestExecutionScopeWithCapabilities(
        baseRequest,
        (request) =>
          createRequestWorkerCapabilityProvider({
            request,
            executionPolicyAuthority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
            runtimeConfig,
            toolRegistryOverride: toolRegistry,
          }),
      );

      await expect(runRequestRunner(request)).resolves.toEqual({
        output: "The requested file was created.",
      });
      await expect(readFile(physicalTarget, "utf8")).resolves.toBe(body);

      expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
        SUPERVISOR_DECISION_MODEL_STEP,
        WORKER_DECISION_MODEL_STEP,
        WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
        WORKER_DECISION_MODEL_STEP,
        SUPERVISOR_DECISION_MODEL_STEP,
        SUPERVISOR_RESPONSE_MODEL_STEP,
      ]);
      expect(invokeRaw).not.toHaveBeenCalled();
      expect(listNormalInvocations).toHaveBeenCalledOnce();
      expect(executeTool).toHaveBeenCalledOnce();
      expect(executeTool.mock.calls[0]![0]).toEqual({
        tool: "write_file",
        params: {
          path: logicalTarget,
          content: body,
        },
      });
      expect(executeTool.mock.calls[0]![1]).toMatchObject({
        abortSignal: request.abortSignal,
        sharedState: {
          currentSessionId: request.sessionId,
          runtimePaths: {
            agentWorkDir,
          },
        },
      });
      const lifecycleEvents = onEvent.mock.calls.filter(
        ([name]) => name !== "context.window.snapshot",
      );
      expect(lifecycleEvents.map(([name]) => name)).toEqual([
        "runtime.state",
        "tool.payload.started",
        "tool.payload.completed",
        "tool.started",
        "tool.completed",
        "runtime.state",
        "runtime.state",
      ]);
      expect(lifecycleEvents[1]![1]).toMatchObject({
        tool: "write_file",
        outputParam: "content",
        payloadStage: 1,
        payloadStageCount: 1,
      });
      expect(lifecycleEvents[2]![1]).toMatchObject({
        tool: "write_file",
        outputParam: "content",
        payloadStage: 1,
        payloadStageCount: 1,
        ok: true,
      });
      expect(lifecycleEvents[4]![1]).toMatchObject({
        tool: "write_file",
        ok: true,
      });

      const logs = consoleLog.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
      expect(
        logs.filter(
          ({ scope, event, decisionPhase }) =>
            scope === "runtime.worker" &&
            event === "model.started" &&
            decisionPhase === "capability_execution",
        ),
      ).toEqual([]);
      expect(
        logs.filter(
          (entry) =>
            entry.scope === "runtime.role_calls" &&
            entry.event === "capability.execution_begun",
        ),
      ).toEqual([
        expect.objectContaining({
          executionId: "capability-execution-1",
          callId: "call-2",
          invocationAttempt: 1,
          capabilityId: "write_complete_file",
          declaredEffect: "mutation",
        }),
      ]);
      expect(
        logs.filter(
          (entry) =>
            entry.scope === "runtime.role_calls" &&
            entry.event === "capability.execution_settled",
        ),
      ).toEqual([
        expect.objectContaining({
          executionId: "capability-execution-1",
          callId: "call-2",
          outcome: "succeeded",
          observedEffect: "mutation",
        }),
      ]);
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: "runtime.worker",
            event: "capability_refinement.skipped",
            decisionPhase: "capability_execution",
            capabilityId: "write_complete_file",
            selectionControlCount: 1,
            remainingControlCount: 0,
            executionGuidanceIncluded: false,
          }),
          expect.objectContaining({
            scope: "runtime.worker_capability_payload",
            event: "author.completed",
            executionId: "capability-preparation:call-2:1:1",
            capabilityId: "write_complete_file",
            controlCount: 1,
            payloadBytes: Buffer.byteLength(body, "utf8"),
          }),
          expect.objectContaining({
            scope: "runtime.registered_tool_worker_capabilities",
            event: "adapter.execution_completed",
            executionId: "capability-execution-1",
            capabilityId: "write_complete_file",
            outcome: "succeeded",
            observedEffect: "mutation",
          }),
          expect.objectContaining({
            scope: "runtime.role_executors",
            event: "executor.continued",
            roleId: "worker",
            executionId: "capability-execution-1",
            fromActivation: 1,
            toActivation: 2,
          }),
          expect.objectContaining({
            scope: "runtime.role_executors",
            event: "executor.completed",
            roleId: "worker",
            activationCount: 2,
          }),
        ]),
      );
      const serializedEvidence = JSON.stringify({
        logs,
        events: onEvent.mock.calls,
      });
      expect(serializedEvidence).not.toContain(body);
      expect(serializedEvidence).not.toContain(hostRoot);
      expect(serializedEvidence).not.toContain("development_loop");
      expect(serializedEvidence).not.toContain("tool_loop");
      expect(serializedEvidence).not.toContain(
        "runtime.compatibility.planner_child",
      );
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
    }
  });

  test("rejects invalid Supervisor output without emitting an answer", async () => {
    const request = createRequest(
      vi.fn(async () => ({ text: encodeDecision("not-json"), meta: {} })),
    );

    await expect(runRequestRunner(request)).rejects.toThrow(
      "invalid_supervisor_decision",
    );
    expect(request.onAnswerToken).not.toHaveBeenCalled();
    expect(request.onThinkingTrace).toHaveBeenCalledWith({
      step: SUPERVISOR_DECISION_MODEL_STEP,
      status: "error",
      text: "",
    });
  });

  test("does not invoke the Supervisor after the request aborts", async () => {
    const abort = new AbortController();
    abort.abort(new Error("request cancelled"));
    const invoke = vi.fn<ModelGatewayClient["invoke"]>();
    const request = createRequest(invoke, { abortSignal: abort.signal });

    await expect(runRequestRunner(request)).rejects.toThrow(
      "request cancelled",
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(request.onAnswerToken).not.toHaveBeenCalled();
  });

  test("characterizes that Supervisor can respond immediately after Reviewer gaps", async () => {
    const plannerObjective =
      "Coordinate one bounded result through Worker execution.";
    const workerObjective = "Produce the bounded result.";
    const workerResult = "The bounded result was produced.";
    const plannerResult = "The Worker produced the bounded result.";
    const reviewerSummary = "One high-level gap remains.";
    let invocationIndex = 0;
    let reviewerDecision: Record<string, unknown> | undefined;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      switch (invocationIndex) {
        case 1:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "planner",
              objective: plannerObjective,
              acknowledgement: REQUEST_ACKNOWLEDGEMENT,
            }),
            meta: {},
          };
        case 2:
          expect(input.modelStep).toBe(PLANNER_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "worker",
              plan: {
                summary: plannerObjective,
                items: [
                  {
                    title: "Produce bounded result",
                    objective: workerObjective,
                  },
                ],
              },
              selectedItemIndexes: [0],
            }),
            meta: {},
          };
        case 3:
          expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "return_result",
              result: workerResult,
            }),
            meta: {},
          };
        case 4:
          expect(input.modelStep).toBe(PLANNER_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "return_result",
              result: plannerResult,
            }),
            meta: {},
          };
        case 5:
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "invoke_role",
              roleId: "reviewer",
            }),
            meta: {},
          };
        case 6: {
          expect(input.modelStep).toBe(REVIEWER_DECISION_MODEL_STEP);
          const assignment = JSON.parse(
            (input.messages as readonly { content: string }[]).at(-1)!.content,
          ) as {
            auditScope: {
              reviewScopeId: string;
            };
            dependencySubjects: readonly {
              roleId: string;
              objective: string;
              outcome: string;
            }[];
            effects: readonly { evidenceRef: string }[];
          };
          expect(assignment.dependencySubjects).toEqual([
            expect.objectContaining({
              roleId: "planner",
              objective: plannerObjective,
              outcome: "completed",
              summary: "The Worker produced the bounded result.",
            }),
          ]);
          reviewerDecision = {
            action: "report_gaps",
            reviewScopeId: assignment.auditScope.reviewScopeId,
            audit: {
              evidenceAssessments: assignment.effects.map(({ evidenceRef }) => ({
                evidenceRef,
                status: "does_not_establish",
                finding: "This evidence does not establish the bounded result.",
              })),
              completionAssessment: {
                status: "gap",
                evidenceRefs: [],
                finding: "The supplied evidence leaves a completion gap.",
              },
            },
            summary: reviewerSummary,
            gaps: [
              {
                kind: "missing_evidence",
                subjectRefs: [],
                factRefs: [],
                evidenceRefs: [],
                summary: "Independent evidence is not represented.",
              },
            ],
          };
          return { text: encodeDecision(reviewerDecision), meta: {} };
        }
        case 7: {
          expect(input.modelStep).toBe(SUPERVISOR_DECISION_MODEL_STEP);
          const returned = JSON.parse(
            (input.messages as readonly { content: string }[]).at(-1)!.content,
          ) as {
            roleId: string;
            outcome: string;
            summary: string;
            reviewerVerdict: Record<string, unknown>;
          };
          expect(returned).toMatchObject({
            roleId: "reviewer",
            outcome: "completed",
            summary: reviewerSummary,
            reviewerVerdict: {
              kind: "reviewer_verdict_v1",
              verdict: "report_gaps",
              gaps: reviewerDecision?.gaps,
            },
          });
          return {
            text: encodeDecision({ action: "respond" }),
            meta: {},
          };
        }
        case 8:
          expect(input.modelStep).toBe(SUPERVISOR_RESPONSE_MODEL_STEP);
          return {
            text: "The reviewed result has returned to the Supervisor.",
            meta: {},
          };
        default:
          throw new Error(`unexpected model invocation ${invocationIndex}`);
      }
    });
    const request = createRequest(invoke);

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "The reviewed result has returned to the Supervisor.",
    });
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      SUPERVISOR_DECISION_MODEL_STEP,
      PLANNER_DECISION_MODEL_STEP,
      WORKER_DECISION_MODEL_STEP,
      PLANNER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      REVIEWER_DECISION_MODEL_STEP,
      SUPERVISOR_DECISION_MODEL_STEP,
      SUPERVISOR_RESPONSE_MODEL_STEP,
    ]);
    expect(
      invoke.mock.calls.filter(
        ([input]) => input.modelStep === WORKER_DECISION_MODEL_STEP,
      ),
    ).toHaveLength(1);
  });
});

async function runObservationHandoffScenario(
  plannerObservation?: RequestObservation,
): Promise<{
  result: Awaited<ReturnType<typeof runSupervisorRootExecution>>;
  logs: Record<string, unknown>[];
  workerObservation: RequestObservation;
}> {
  configureDebugLogger({ enabled: true });
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const workerObservation = createObservation("worker-observation");
  const invoke = vi
    .fn<ModelGatewayClient["invoke"]>()
    .mockResolvedValueOnce({
      text: encodeDecision({
        action: "invoke_role",
        roleId: "worker",
        objective: "Return the first bounded result.",
        acknowledgement: REQUEST_ACKNOWLEDGEMENT,
      }),
      meta: {},
    })
    .mockResolvedValueOnce({
      text: encodeDecision({
        action: "invoke_role",
        roleId: "planner",
        objective: "Return the second bounded result.",
      }),
      meta: {},
    })
    .mockResolvedValueOnce({
      text: encodeDecision({ action: "respond" }),
      meta: {},
    })
    .mockResolvedValueOnce({
      text: "The exact delegated results were incorporated.",
      meta: {},
    });
  const request = createRequest(invoke);
  const ledger = await createSupervisorRootLedger(request.requestId);
  const roleExecutors = createRoleExecutorRegistry<
    RequestExecutionScope,
    RequestRoleExecutionHandoff
  >([
    createObservationRoleExecutor(
      "worker",
      "The first bounded result is complete.",
      workerObservation,
    ),
    createObservationRoleExecutor(
      "planner",
      "The second bounded result is complete.",
      plannerObservation,
    ),
  ]);
  const scopedRequest = rebindTestRequestExecutionPolicy(
    request,
    Object.freeze({
      authority: ledger.current().policy.authority,
      rootContract: SUPERVISOR_ROOT_CONTRACT,
      roleExecutors,
    }),
  );
  try {
    const result = await runSupervisorRootExecution({
      request: scopedRequest,
      ledger,
    });
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    return { result, logs, workerObservation };
  } finally {
    consoleLog.mockRestore();
  }
}

function createObservationRoleExecutor(
  roleId: "worker" | "planner",
  summary: string,
  finalObservation?: RequestObservation,
): RoleExecutor<RequestExecutionScope, RequestRoleExecutionHandoff> {
  return Object.freeze({
    roleId,
    async execute() {
      return Object.freeze({
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary,
        ...(finalObservation
          ? { value: Object.freeze({ finalObservation }) }
          : {}),
      });
    },
  });
}

function createObservation(content: string): RequestObservation {
  return Object.freeze({
    observationMeta: Object.freeze({
      kind: "task_result" as const,
      carryPolicy: "never" as const,
      taskResultRole: "authoritative_project_handoff" as const,
    }),
    observationContent: content,
  });
}

async function createSupervisorRootLedger(
  requestId: string,
): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  const created = await ledger.apply({
    expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" },
  });
  if (!created.ok) {
    throw new Error(`test_root_creation_failed:${created.code}`);
  }
  return ledger;
}

function readObservationHandoffLogs(
  logs: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return logs.filter(
    (entry) =>
      entry.scope === "runtime.supervisor_root" &&
      entry.event === "observation_handoff.bound",
  );
}

function createToolRegistry(
  params: Readonly<{
    listNormalInvocations: () => readonly RegisteredToolNormalInvocation[];
    prepareSharedState: NonNullable<ToolRegistry["prepareSharedState"]>;
    execute: ToolRegistry["execute"];
  }>,
): ToolRegistry {
  const registration = systemStateRegistration();
  return {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: params.listNormalInvocations,
    getDefinition: (name) =>
      name === registration.definition.name
        ? registration.definition
        : undefined,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    prepareSharedState: params.prepareSharedState,
    execute: params.execute,
  };
}

function systemStateRegistration(): RegisteredToolNormalInvocation {
  const operation: ToolNormalInvocationOperation = {
    operationId: "inspect_system_state",
    summary: "Inspect current system state.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    effect: "read_only",
    approval: "request_policy",
  };
  return {
    toolName: "system_probe",
    definition: {
      name: "system_probe",
      routingCapability: "filesystem_inspection",
      executionEffect: "read_only",
      params: {},
    },
    contract: {
      version: 1,
      operations: [operation],
    },
  };
}

function systemStateExecutionResult(output: string): ToolExecutionResult {
  return {
    ok: true,
    tool: "system_probe",
    output,
    producedNewInformation: true,
    data: { currentStateEvidence: true },
  };
}

function createMutationRuntimeConfig(
  hostRoot: string,
  agentWorkDir: string,
): RuntimeConfig {
  const runtimeDir = join(hostRoot, ".runtime");
  return {
    runtimeId: "supervisor-worker-mutation-test",
    agentBridgeUrl: "ws://test",
    modelGatewayUrl: "http://model",
    paths: {
      rootDir: process.cwd(),
      runtimeDir,
      agentWorkDir,
      sessionsDir: join(runtimeDir, "sessions"),
      attachmentsDir: join(runtimeDir, "attachments"),
      workspaceDir: join(runtimeDir, "workspace"),
      sharedDir: join(runtimeDir, "shared"),
      compiledDir: join(runtimeDir, "compiled"),
      traceFile: join(runtimeDir, "logs", "runtime-debug.jsonl"),
    },
    plugins: {
      enabled: true,
      allow: ["filesystem.write_file"],
    },
    requestRunner: {
      configPath: join(hostRoot, "request-runner.config.json"),
    },
  };
}
