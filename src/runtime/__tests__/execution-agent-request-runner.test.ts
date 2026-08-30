import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import type { ChatMessage } from "../../model-gateway/types.js";
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
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import {
  CAPABILITY_CONTROLS_MODEL_STEP,
  WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
} from "../orchestration/worker-capabilities/index.js";
import type { ModelGatewayClient, ToolRegistry } from "../ports.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import type { RequestCapabilityExecutionView } from "../request/execution-scope.js";
import {
  createTestRequestExecutionScope,
  createTestRequestExecutionScopeWithCapabilities,
} from "./support/request-execution-scope.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import {
  EXECUTION_AGENT_ACTION_MESSAGE_KIND,
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  EXECUTION_AGENT_RESPONSE_MODEL_STEP,
  EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
  EXECUTION_CAPABILITY_TOOL_NAME,
} from "../steps/execution-agent/index.js";

const REQUEST_PROMPT = "Inspect exact.txt and report the observed result.";
const FILE_GROUP = "files";
const EXACT_INTENT = "Observe exact.txt for the requested answer.";
const EXACT_CONTROLS = Object.freeze({ path: "exact.txt" });
const EXACT_RESPONSE = [
  "  Exact observation completed.",
  "```json",
  '{"quoted":"value with \\\"quotes\\\""}',
  "```",
  "Final line.\t",
].join("\n");
const MEMORY_CANDIDATE = Object.freeze({
  content: "The user asked to inspect exact.txt.",
  tags: Object.freeze(["request-preference"]),
});
const DIRECT_WRITE_PROMPT =
  "Create project/direct.txt with the exact content `green` followed by one newline.";
const DIRECT_WRITE_INTENT =
  "Write green followed by one newline to project/direct.txt.";
const DIRECT_WRITE_BODY = "green\n";

const observeDescriptor: WorkerCapabilityDescriptor = Object.freeze({
  capabilityId: "files.observe_exact",
  summary: "Observe one exact file.",
  effect: "observation" as const,
  controls: Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties: Object.freeze({
      path: Object.freeze({
        type: "string" as const,
        minLength: 1,
        maxLength: 4_096,
      }),
    }),
    required: Object.freeze(["path"]),
  }),
  selectionControlIds: Object.freeze(["path"]),
  controlsRefinement: "mechanical_when_complete" as const,
  catalogGroups: Object.freeze([FILE_GROUP]),
});

const runnerConfig: RequestRunnerConfig = Object.freeze({
  models: Object.freeze({
    defaults: Object.freeze({
      profileId: "execution-agent-runner-test",
      steps: Object.freeze({
        [EXECUTION_AGENT_DECISION_MODEL_STEP]: "execution.decision",
        [EXECUTION_AGENT_RESPONSE_MODEL_STEP]: "execution.response",
        [CAPABILITY_CONTROLS_MODEL_STEP]: "capability.controls",
        [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: "toolPayload.raw",
      }),
    }),
  }),
  context: Object.freeze({
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  }),
  steps: Object.freeze({
    [EXECUTION_AGENT_DECISION_MODEL_STEP]: Object.freeze({
      timeoutMs: 20_000,
    }),
    [EXECUTION_AGENT_RESPONSE_MODEL_STEP]: Object.freeze({
      timeoutMs: 20_000,
    }),
    [CAPABILITY_CONTROLS_MODEL_STEP]: Object.freeze({
      timeoutMs: 20_000,
    }),
    [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: Object.freeze({
      timeoutMs: 20_000,
    }),
  }),
});

const modelPolicy = Object.freeze({
  providers: Object.freeze({
    local: Object.freeze({ type: "ollama" as const }),
  }),
  profiles: Object.freeze({
    "execution-agent-runner-test": Object.freeze({
      provider: "local",
      model: "execution-agent-runner-test:latest",
      contextWindowTokens: 32_000,
    }),
  }),
  defaults: Object.freeze({
    profileId: "execution-agent-runner-test",
    steps: Object.freeze({
      [EXECUTION_AGENT_DECISION_MODEL_STEP]: "execution.decision",
      [EXECUTION_AGENT_RESPONSE_MODEL_STEP]: "execution.response",
      [CAPABILITY_CONTROLS_MODEL_STEP]: "capability.controls",
      [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: "toolPayload.raw",
    }),
  }),
});

function encodeDecision(decision: unknown): string {
  return JSON.stringify({ decision });
}

function asMessages(value: unknown): readonly ChatMessage[] {
  validateModelGatewayMessages(value);
  if (!Array.isArray(value)) throw new Error("expected model messages");
  return value as readonly ChatMessage[];
}

function collectPropertySchemas(
  value: unknown,
  propertyId: string,
): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectPropertySchemas(entry, propertyId));
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const properties =
    record.properties &&
    typeof record.properties === "object" &&
    !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;
  const direct = properties?.[propertyId];
  return [
    ...(direct && typeof direct === "object" && !Array.isArray(direct)
      ? [direct as Record<string, unknown>]
      : []),
    ...Object.values(record).flatMap((entry) =>
      collectPropertySchemas(entry, propertyId),
    ),
  ];
}

function expectCurrentRequestOnce(messages: readonly ChatMessage[]): void {
  expect(
    messages.filter(
      (message) =>
        message.role === "user" && message.content === REQUEST_PROMPT,
    ),
  ).toHaveLength(1);
}

function readToolLane(messages: readonly ChatMessage[]): Readonly<{
  action: Record<string, unknown>;
  result: Record<string, unknown>;
}> {
  const actionMessage = messages.find(
    (message) => message.role === "assistant" && "toolCalls" in message,
  );
  const resultMessage = messages.find((message) => message.role === "tool");
  if (
    !actionMessage ||
    actionMessage.role !== "assistant" ||
    !("toolCalls" in actionMessage) ||
    !actionMessage.toolCalls ||
    actionMessage.toolCalls.length !== 1 ||
    !resultMessage ||
    resultMessage.role !== "tool"
  ) {
    throw new Error("expected one native tool lane");
  }
  expect(actionMessage).toMatchObject({
    content: "",
    toolCalls: [
      {
        callId: "capability-execution-1",
        name: EXECUTION_CAPABILITY_TOOL_NAME,
      },
    ],
  });
  expect(resultMessage).toMatchObject({
    toolCallId: "capability-execution-1",
    toolName: EXECUTION_CAPABILITY_TOOL_NAME,
  });
  return Object.freeze({
    action: JSON.parse(actionMessage.toolCalls[0]!.arguments) as Record<
      string,
      unknown
    >,
    result: JSON.parse(resultMessage.content) as Record<string, unknown>,
  });
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Execution Agent request runner", () => {
  test("runs scope selection, one exact capability receipt, and one structured memory-aware response through the shared kernel", async () => {
    const timeline: string[] = [];
    const execute = vi.fn<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
    >(async (input) => {
      timeline.push("adapter");
      expect(input).toMatchObject({
        executionId: "capability-execution-1",
        intent: EXACT_INTENT,
        controls: EXACT_CONTROLS,
        settledCapabilityResults: [],
        call: {
          callId: "call-1",
          parentCallId: null,
          roleId: "supervisor",
          depth: 0,
          activationCount: 2,
          workerCapabilityScope: { catalogGroupIds: [FILE_GROUP] },
          workingDirectory: "project",
        },
      });
      return {
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "Observed exact.txt.",
        referenceData: "exact-file-content",
        references: Object.freeze([
          Object.freeze({ kind: "tool_target" as const, target: "exact.txt" }),
        ]),
      };
    });
    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
      Object.freeze({ descriptor: observeDescriptor, execute });
    const getDescriptors = vi.fn(() => Object.freeze([observeDescriptor]));
    const getAdapters = vi.fn(() => Object.freeze([adapter]));
    const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      const messages = asMessages(input.messages);
      expectCurrentRequestOnce(messages);
      timeline.push(`model:${String(input.modelStep)}:${invocationIndex}`);

      switch (invocationIndex) {
        case 1:
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          expect(messages.some((message) => message.role === "tool")).toBe(
            false,
          );
          return {
            text: encodeDecision({
              action: "open_capability_scope",
              catalogGroupIds: [FILE_GROUP],
              acknowledgement: "I will inspect the exact file.",
              title: "Exact file inspection",
            }),
            meta: {},
          };
        case 2:
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          expect(timeline).toEqual([
            `model:${EXECUTION_AGENT_DECISION_MODEL_STEP}:1`,
            "title",
            "acknowledgement",
            `model:${EXECUTION_AGENT_DECISION_MODEL_STEP}:2`,
          ]);
          expect(messages.some((message) => message.role === "tool")).toBe(
            false,
          );
          return {
            text: encodeDecision({
              action: "invoke_capability",
              capabilityId: observeDescriptor.capabilityId,
              intent: EXACT_INTENT,
              selectionControls: EXACT_CONTROLS,
              workingDirectory: "project",
            }),
            meta: {},
          };
        case 3: {
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          expect(timeline.at(-2)).toBe("adapter");
          const lane = readToolLane(messages);
          expect(lane.action).toEqual({
            kind: EXECUTION_AGENT_ACTION_MESSAGE_KIND,
            authority: "accepted_execution_agent_action",
            invocationAttempt: 2,
            invocationIndex: 0,
            invocationCount: 1,
            action: "invoke_capability",
            invocation: {
              executionId: "capability-execution-1",
              capabilityId: observeDescriptor.capabilityId,
              controls: EXACT_CONTROLS,
              declaredEffect: "observation",
            },
          });
          expect(JSON.stringify(lane.action)).not.toContain(EXACT_INTENT);
          expect(lane.result).toEqual({
            kind: EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
            authority: "capability_adapter_result",
            presenceEffect: "runtime_result_only_not_user_intent",
            invocationAttempt: 2,
            result: {
              executionId: "capability-execution-1",
              capabilityId: observeDescriptor.capabilityId,
              adapterResult: {
                kind: "generic_capability_result_v1",
                authority: "capability_adapter",
                status: "executed",
                ok: true,
                payload: {
                  outcome: "succeeded",
                  observedEffect: "observation",
                  summary: "Observed exact.txt.",
                  referenceData: "exact-file-content",
                },
                references: [{ kind: "tool_target", target: "exact.txt" }],
              },
            },
          });
          return {
            text: encodeDecision({ action: "respond" }),
            meta: {},
          };
        }
        case 4: {
          expect(input.modelStep).toBe(EXECUTION_AGENT_RESPONSE_MODEL_STEP);
          expect(input.format).toMatchObject({
            type: "json_schema",
            name: "root_authored_response",
          });
          const lane = readToolLane(messages);
          expect(lane.result).toMatchObject({
            result: {
              executionId: "capability-execution-1",
              adapterResult: {
                kind: "generic_capability_result_v1",
                ok: true,
                payload: {
                  summary: "Observed exact.txt.",
                },
              },
            },
          });
          expect(timeline).toEqual([
            `model:${EXECUTION_AGENT_DECISION_MODEL_STEP}:1`,
            "title",
            "acknowledgement",
            `model:${EXECUTION_AGENT_DECISION_MODEL_STEP}:2`,
            "adapter",
            `model:${EXECUTION_AGENT_DECISION_MODEL_STEP}:3`,
            `model:${EXECUTION_AGENT_RESPONSE_MODEL_STEP}:4`,
          ]);
          return {
            text: buildMemoryAuthoredResponse(),
            meta: {},
          };
        }
        default:
          throw new Error(`unexpected model invocation: ${invocationIndex}`);
      }
    });
    const onSessionTitle = vi.fn(async (title: string) => {
      timeline.push("title");
      expect(title).toBe("Exact file inspection");
    });
    const onAcknowledgement = vi.fn((acknowledgement: string) => {
      timeline.push("acknowledgement");
      expect(acknowledgement).toBe("I will inspect the exact file.");
    });
    const onAnswerToken = vi.fn((token: string) => {
      timeline.push("answer");
      expect(token).toBe(EXACT_RESPONSE);
    });
    const request = createTestRequestExecutionScope({
      requestId: "execution-agent-runner-request",
      sessionId: "execution-agent-runner-session",
      prompt: REQUEST_PROMPT,
      historyMessages: [],
      shouldGenerateSessionTitle: true,
      runnerConfig,
      executionPolicySelection: Object.freeze({
        policy: "execution-agent-v1" as const,
        primaryProfileId: "execution-agent-runner-test",
        source: "model_profile" as const,
      }),
      agentMode: "reasoning",
      modelPolicy,
      modelGatewayClient: { invoke, invokeRaw },
      longTermMemory: {
        enabled: true,
        retrieve: vi.fn(async () => ({ available: true, records: [] })),
        processCandidates: vi.fn(),
        scheduleCandidates: vi.fn(),
        status: vi.fn(),
        list: vi.fn(),
        search: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      },
      workerCapabilityProvider: {
        getDescriptors,
        getAdapters,
      },
      toolPermissionMode: "full_access",
      abortSignal: new AbortController().signal,
      onAcknowledgement,
      onSessionTitle,
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken,
      onEvent: vi.fn(),
    });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: EXACT_RESPONSE,
      outputTextMode: "exact",
      memoryCandidates: [MEMORY_CANDIDATE],
    });

    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      EXECUTION_AGENT_DECISION_MODEL_STEP,
      EXECUTION_AGENT_DECISION_MODEL_STEP,
      EXECUTION_AGENT_DECISION_MODEL_STEP,
      EXECUTION_AGENT_RESPONSE_MODEL_STEP,
    ]);
    expect(
      invoke.mock.calls
        .map(([input]) => JSON.stringify(input.messages))
        .join("\n"),
    ).not.toMatch(
      /runtime_(supervisor_assignment|worker_assignment|reviewer_assignment)/u,
    );
    expect(invokeRaw).not.toHaveBeenCalled();
    expect(getAdapters).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(onSessionTitle).toHaveBeenCalledExactlyOnceWith(
      "Exact file inspection",
    );
    expect(onAcknowledgement).toHaveBeenCalledExactlyOnceWith(
      "I will inspect the exact file.",
    );
    expect(onAnswerToken).toHaveBeenCalledExactlyOnceWith(EXACT_RESPONSE);
    expect(timeline.at(-1)).toBe("answer");
  });

  test("preserves a selection-bound target and prior continuation in control refinement", async () => {
    const firstIntent = "Apply the requested update to exact.txt.";
    const secondIntent = "Verify the completed update to exact.txt.";
    const operationObjective = "Apply only the bounded edit to exact.txt.";
    const longCommand = `cat <<'EOF' > exact.txt\n${"x".repeat(4_096)}\nEOF`;
    expect(longCommand.length).toBeGreaterThan(4_096);
    const descriptor: WorkerCapabilityDescriptor = Object.freeze({
      capabilityId: "files.edit_exact",
      summary: "Edit one exact file.",
      effect: "mutation" as const,
      controls: Object.freeze({
        type: "object" as const,
        additionalProperties: false as const,
        properties: Object.freeze({
          path: Object.freeze({
            type: "string" as const,
            minLength: 1,
            maxLength: 4_096,
          }),
          instruction: Object.freeze({
            type: "string" as const,
            minLength: 1,
            maxLength: 4_096,
          }),
          command: Object.freeze({
            type: "string" as const,
            minLength: 1,
          }),
        }),
        required: Object.freeze(["path", "instruction", "command"]),
      }),
      selectionControlIds: Object.freeze(["path"]),
      runtimePathControlIds: Object.freeze(["path"]),
      catalogGroups: Object.freeze([FILE_GROUP]),
    });
    const execute = vi.fn<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
    >(async (input) => {
      expect(input.controls).toEqual({
        path: "exact.txt",
        instruction: "Preserve the exact file while applying the request.",
        command: longCommand,
      });
      return {
        outcome: "succeeded" as const,
        observedEffect: "mutation" as const,
        summary: "Edited exact.txt.",
        referenceData: "exact-refinement-evidence",
      };
    });
    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
      Object.freeze({ descriptor, execute });
    let invocationIndex = 0;
    const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      const messages = asMessages(input.messages);
      switch (invocationIndex) {
        case 1:
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "open_capability_scope",
              catalogGroupIds: [FILE_GROUP],
              acknowledgement: "I will update the requested file.",
            }),
            meta: {},
          };
        case 2:
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          expect(JSON.stringify(input.format)).toContain("selectionControls");
          return {
            text: encodeDecision({
              action: "invoke_capability",
              capabilityId: descriptor.capabilityId,
              intent: firstIntent,
              operationObjective,
              selectionControls: { path: "exact.txt" },
              workingDirectory: null,
            }),
            meta: {},
          };
        case 3: {
          expect(input.modelStep).toBe(CAPABILITY_CONTROLS_MODEL_STEP);
          expect(messages.filter(({ role }) => role === "tool")).toHaveLength(
            0,
          );
          const assignment = messages
            .map(({ content }) => {
              try {
                return JSON.parse(content) as Record<string, unknown>;
              } catch {
                return undefined;
              }
            })
            .find(
              (value) =>
                value?.kind === "runtime_execution_capability_refinement_v1",
            );
          expect(assignment).toMatchObject({
            invocations: [
              {
                capabilityId: descriptor.capabilityId,
                selectionControls: { path: "exact.txt" },
                remainingControls: {
                  required: ["instruction", "command"],
                  properties: {
                    instruction: {
                      type: "string",
                      minLength: 1,
                      maxLength: 4_096,
                    },
                    command: { type: "string", minLength: 1 },
                  },
                },
              },
            ],
          });
          expect(collectPropertySchemas(input.format, "path")).toHaveLength(0);
          expect(JSON.stringify(input.format)).toContain('"instruction"');
          const commandSchemas = collectPropertySchemas(
            input.format,
            "command",
          );
          expect(commandSchemas.length).toBeGreaterThan(0);
          expect(commandSchemas).toEqual(
            commandSchemas.map(() => ({ type: "string", minLength: 1 })),
          );
          return {
            text: encodeDecision({
              invocations: {
                invocation_1: {
                  disposition: "execute",
                  controls: {
                    instruction:
                      "Preserve the exact file while applying the request.",
                    command: longCommand,
                  },
                },
              },
            }),
            meta: {},
          };
        }
        case 4:
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "invoke_capability",
              capabilityId: descriptor.capabilityId,
              intent: secondIntent,
              operationObjective,
              selectionControls: { path: "exact.txt" },
            }),
            meta: {},
          };
        case 5: {
          expect(input.modelStep).toBe(CAPABILITY_CONTROLS_MODEL_STEP);
          const resultMessages = messages.filter(
            (message) => message.role === "tool",
          );
          expect(resultMessages).toHaveLength(1);
          expect(JSON.parse(resultMessages[0]!.content)).toMatchObject({
            result: {
              executionId: "capability-execution-1",
              capabilityId: descriptor.capabilityId,
              adapterResult: {
                kind: "generic_capability_result_v1",
                status: "executed",
                payload: {
                  outcome: "succeeded",
                  summary: "Edited exact.txt.",
                  referenceData: "exact-refinement-evidence",
                },
              },
            },
          });
          expect(JSON.stringify(messages)).not.toContain(firstIntent);
          expect(JSON.stringify(messages)).not.toContain(secondIntent);
          expect(JSON.stringify(messages)).toContain(operationObjective);
          return {
            text: encodeDecision({
              invocations: {
                invocation_1: {
                  disposition: "execute",
                  controls: {
                    instruction:
                      "Preserve the exact file while applying the request.",
                    command: longCommand,
                  },
                },
              },
            }),
            meta: {},
          };
        }
        case 6:
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          expect(messages.filter(({ role }) => role === "tool")).toHaveLength(
            2,
          );
          return { text: encodeDecision({ action: "respond" }), meta: {} };
        case 7:
          expect(input.modelStep).toBe(EXECUTION_AGENT_RESPONSE_MODEL_STEP);
          return { text: "Updated exact.txt.", meta: {} };
        default:
          throw new Error(`unexpected model invocation: ${invocationIndex}`);
      }
    });
    const request = createTestRequestExecutionScope({
      requestId: "execution-agent-frozen-partition-request",
      sessionId: "execution-agent-frozen-partition-session",
      prompt: REQUEST_PROMPT,
      historyMessages: [],
      sessionArtifactPaths: Object.freeze(["exact.txt"]),
      shouldGenerateSessionTitle: false,
      runnerConfig,
      executionPolicySelection: Object.freeze({
        policy: "execution-agent-v1" as const,
        primaryProfileId: "execution-agent-runner-test",
        source: "model_profile" as const,
      }),
      agentMode: "reasoning",
      modelPolicy,
      modelGatewayClient: { invoke, invokeRaw },
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([descriptor]),
        getAdapters: () => Object.freeze([adapter]),
      },
      toolPermissionMode: "full_access",
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent: vi.fn(),
    });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Updated exact.txt.",
      outputTextMode: "exact",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(invokeRaw).not.toHaveBeenCalled();
  });

  test("executes a frozen capability selection without a semantic refinement veto", async () => {
    const requestSteering = createRequestSteeringInbox({
      requestId: "execution-agent-frozen-refinement-request",
    });
    expect(
      requestSteering.append({
        steerId: "refinement-update-1",
        text: "Inspect exact.txt and preserve its exact result.",
      }),
    ).toMatchObject({ ok: true, duplicate: false });
    const execute =
      vi.fn<
        WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
      >();
    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
      Object.freeze({
        descriptor: observeDescriptor,
        execute,
      });
    const getDescriptors = vi.fn(() => Object.freeze([observeDescriptor]));
    const getAdapters = vi.fn(() => Object.freeze([adapter]));
    const getExecutionGuidance = vi.fn(
      async () =>
        "This capability performs one observation and does not decide whether the request later needs another action.",
    );
    const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      const messages = asMessages(input.messages);
      switch (invocationIndex) {
        case 1:
          return {
            text: encodeDecision({
              action: "open_capability_scope",
              catalogGroupIds: [FILE_GROUP],
              acknowledgement: "I will inspect the requested file.",
            }),
            meta: {},
          };
        case 2:
          return {
            text: encodeDecision({
              action: "invoke_capability",
              capabilityId: observeDescriptor.capabilityId,
              intent: EXACT_INTENT,
              selectionControls: EXACT_CONTROLS,
              workingDirectory: ".",
            }),
            meta: {},
          };
        case 3: {
          const serializedFormat = JSON.stringify(input.format);
          expect(serializedFormat).not.toContain('"reconsider"');
          expect(serializedFormat).not.toContain('"reason"');
          const assignment = messages.find(({ content }) => {
            try {
              return (
                (JSON.parse(content) as Record<string, unknown>).kind ===
                "runtime_execution_capability_refinement_v1"
              );
            } catch {
              return false;
            }
          });
          expect(assignment).toBeDefined();
          const steering = messages.find(({ content }) => {
            try {
              return (
                (JSON.parse(content) as Record<string, unknown>).kind ===
                "runtime_active_request_updates_v1"
              );
            } catch {
              return false;
            }
          });
          expect(JSON.parse(steering!.content)).toMatchObject({
            authority: "user",
            version: 1,
            updates: [
              {
                sequence: 1,
                text: "Inspect exact.txt and preserve its exact result.",
              },
            ],
          });
          return {
            text: encodeDecision({
              invocations: {
                invocation_1: {
                  disposition: "execute",
                  controls: {},
                },
              },
            }),
            meta: {},
          };
        }
        case 4: {
          expect(messages.some(({ role }) => role === "tool")).toBe(true);
          const state = messages
            .filter(({ role }) => role === "user")
            .map(({ content }) => {
              try {
                return JSON.parse(content) as Record<string, unknown>;
              } catch {
                return undefined;
              }
            })
            .find((value) => value?.kind === "runtime_execution_state_v1");
          expect(state).toBeDefined();
          expect(state).not.toHaveProperty(
            "capabilitySelectionReconsideration",
          );
          return { text: encodeDecision({ action: "respond" }), meta: {} };
        }
        case 5:
          return { text: "The requested file was observed.", meta: {} };
        default:
          throw new Error(`unexpected model invocation: ${invocationIndex}`);
      }
    });
    const request = createTestRequestExecutionScope({
      requestId: "execution-agent-frozen-refinement-request",
      sessionId: "execution-agent-frozen-refinement-session",
      prompt: REQUEST_PROMPT,
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      runnerConfig,
      executionPolicySelection: Object.freeze({
        policy: "execution-agent-v1" as const,
        primaryProfileId: "execution-agent-runner-test",
        source: "model_profile" as const,
      }),
      agentMode: "reasoning",
      modelPolicy,
      modelGatewayClient: { invoke, invokeRaw },
      workerCapabilityProvider: {
        getDescriptors,
        getAdapters,
        getExecutionGuidance,
      },
      requestSteering,
      toolPermissionMode: "full_access",
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent: vi.fn(),
    });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "The requested file was observed.",
      outputTextMode: "exact",
    });
    expect(invoke).toHaveBeenCalledTimes(5);
    expect(getExecutionGuidance).toHaveBeenCalledOnce();
    expect(getExecutionGuidance).toHaveBeenCalledWith(
      observeDescriptor.capabilityId,
    );
    expect(getAdapters).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].controls).toEqual(EXACT_CONTROLS);
    expect(invokeRaw).not.toHaveBeenCalled();
  });

  test("settles exhausted refinement validation as reconsideration instead of failing the request", async () => {
    const execute =
      vi.fn<
        WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
      >();
    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
      Object.freeze({ descriptor: observeDescriptor, execute });
    let invocationIndex = 0;
    const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      const messages = asMessages(input.messages);
      if (invocationIndex === 1) {
        return {
          text: encodeDecision({
            action: "open_capability_scope",
            catalogGroupIds: [FILE_GROUP],
            acknowledgement: "I will inspect the requested file.",
          }),
          meta: {},
        };
      }
      if (invocationIndex === 2) {
        return {
          text: encodeDecision({
            action: "invoke_capability",
            capabilityId: observeDescriptor.capabilityId,
            intent: EXACT_INTENT,
            selectionControls: EXACT_CONTROLS,
            workingDirectory: null,
          }),
          meta: {},
        };
      }
      if (invocationIndex >= 3 && invocationIndex <= 5) {
        expect(
          messages.some(({ content }) =>
            content.includes("runtime_execution_capability_refinement_v1"),
          ),
        ).toBe(true);
        return {
          text: encodeDecision({
            invocations: {
              invocation_1: {
                disposition: "reconsider",
                reason: "legacy-semantic-veto-must-be-rejected",
              },
            },
          }),
          meta: {},
        };
      }
      if (invocationIndex === 6) {
        const state = messages
          .map(({ content }) => {
            try {
              return JSON.parse(content) as Record<string, unknown>;
            } catch {
              return undefined;
            }
          })
          .find((value) => value?.kind === "runtime_execution_state_v1");
        expect(state).toMatchObject({
          capabilitySelectionReconsideration: {
            authority: "canonical_role_call_ledger",
            outcome: "reconsidered_before_execution",
            executionOccurred: false,
            cause: {
              kind: "refinement_invalid_output",
              validationStage: "domain_parser",
              issues: expect.arrayContaining([
                expect.objectContaining({
                  code: expect.any(String),
                  path: expect.any(String),
                }),
              ]),
              repairAttempts: expect.any(Number),
              repeatedInvalidOutput: true,
            },
            selection: {
              action: "invoke_capability",
              invocations: [
                {
                  capabilityId: observeDescriptor.capabilityId,
                  selectionControls: EXACT_CONTROLS,
                },
              ],
            },
          },
        });
        expect(JSON.stringify(state)).not.toContain(
          "legacy-semantic-veto-must-be-rejected",
        );
        return { text: encodeDecision({ action: "respond" }), meta: {} };
      }
      if (invocationIndex === 7) {
        return {
          text: "The invalid selection was reconsidered safely.",
          meta: {},
        };
      }
      throw new Error(`unexpected model invocation: ${invocationIndex}`);
    });
    const request = createTestRequestExecutionScope({
      requestId: "execution-agent-invalid-refinement-request",
      sessionId: "execution-agent-invalid-refinement-session",
      prompt: REQUEST_PROMPT,
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      runnerConfig,
      executionPolicySelection: Object.freeze({
        policy: "execution-agent-v1" as const,
        primaryProfileId: "execution-agent-runner-test",
        source: "model_profile" as const,
      }),
      agentMode: "reasoning",
      modelPolicy,
      modelGatewayClient: { invoke, invokeRaw },
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([observeDescriptor]),
        getAdapters: () => Object.freeze([adapter]),
        getExecutionGuidance: async () =>
          "Confirm applicability before inspecting the file.",
      },
      toolPermissionMode: "full_access",
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent: vi.fn(),
    });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "The invalid selection was reconsidered safely.",
      outputTextMode: "exact",
    });
    expect(invoke).toHaveBeenCalledTimes(7);
    expect(execute).not.toHaveBeenCalled();
    expect(invokeRaw).not.toHaveBeenCalled();
  });

  test("authors one direct root write payload and executes the registered adapter once", async () => {
    const registration = directWriteRegistration();
    const listNormalInvocations = vi.fn(() => [registration]);
    const executeTool = vi.fn<ToolRegistry["execute"]>(
      async (): Promise<ToolExecutionResult> => ({
        ok: true,
        tool: "write_file",
        output: "Created project/direct.txt.",
        producedNewInformation: true,
        actions: [
          {
            type: "establish_target",
            target: "project/direct.txt",
          },
        ],
        data: { mutationEvidence: true },
      }),
    );
    const toolRegistry = directWriteRegistry({
      registration,
      listNormalInvocations,
      execute: executeTool,
    });
    const onEvent = vi.fn();
    let invocationIndex = 0;
    const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      const messages = asMessages(input.messages);

      switch (invocationIndex) {
        case 1:
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "open_capability_scope",
              catalogGroupIds: [FILE_GROUP],
              acknowledgement: "I will create the exact requested file.",
              title: "Direct file creation",
            }),
            meta: {},
          };
        case 2:
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          return {
            text: encodeDecision({
              action: "invoke_capability",
              capabilityId: "write_complete_file",
              intent: DIRECT_WRITE_INTENT,
              selectionControls: { path: "project/direct.txt" },
              workingDirectory: null,
            }),
            meta: {},
          };
        case 3: {
          expect(input.modelStep).toBe(
            WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
          );
          const source = messages.find(({ content }) => {
            try {
              return (
                (JSON.parse(content) as Record<string, unknown>).kind ===
                "runtime_request_source_v1"
              );
            } catch {
              return false;
            }
          });
          expect(JSON.parse(source!.content)).toMatchObject({
            currentRequest: DIRECT_WRITE_PROMPT,
          });
          const canonical = messages.find(({ content }) =>
            content.startsWith("Canonical runtime context:\n"),
          );
          const context = JSON.parse(
            canonical!.content.replace("Canonical runtime context:\n", ""),
          ) as Record<string, unknown>;
          expect(context).toMatchObject({
            root: {
              callId: "call-1",
              invocationAttempt: 2,
              objectiveSource: "runtime_request_source_plus_steering_v1",
              steeringVersion: 0,
              updates: [],
            },
            acceptedCapability: {
              capabilityId: "write_complete_file",
              controls: { path: "project/direct.txt" },
            },
          });
          expect(context).not.toHaveProperty("worker");
          expect(messages[0]?.content).toContain(
            "root.updates through the frozen root.steeringVersion",
          );
          expect(messages[0]?.content).toContain(
            "acceptedCapability.controls are the immutable execution parameters",
          );
          expect(messages[0]?.content).not.toContain("Worker objective");
          return { text: DIRECT_WRITE_BODY, meta: {} };
        }
        case 4: {
          expect(input.modelStep).toBe(EXECUTION_AGENT_DECISION_MODEL_STEP);
          const state = messages
            .filter(({ role }) => role === "user")
            .map(({ content }) => {
              try {
                return JSON.parse(content) as Record<string, unknown>;
              } catch {
                return undefined;
              }
            })
            .find((value) => value?.kind === "runtime_execution_state_v1");
          expect(state).toMatchObject({ workingDirectory: "." });
          const lane = readToolLane(messages);
          expect(lane.result).toMatchObject({
            result: {
              executionId: "capability-execution-1",
              capabilityId: "write_complete_file",
              adapterResult: {
                kind: "registered_tool_execution_result_v1",
                authority: "registered_plugin",
                status: "executed",
                result: {
                  ok: true,
                  tool: "write_file",
                  output: "Created project/direct.txt.",
                  producedNewInformation: true,
                  actions: [
                    {
                      type: "establish_target",
                      target: "project/direct.txt",
                    },
                  ],
                  data: { mutationEvidence: true },
                },
                references: [
                  { kind: "tool_target", target: "project/direct.txt" },
                ],
              },
            },
          });
          return { text: encodeDecision({ action: "respond" }), meta: {} };
        }
        case 5:
          expect(input.modelStep).toBe(EXECUTION_AGENT_RESPONSE_MODEL_STEP);
          return { text: "Created project/direct.txt.", meta: {} };
        default:
          throw new Error(`unexpected model invocation: ${invocationIndex}`);
      }
    });
    const requestBase = {
      requestId: "execution-agent-direct-write-request",
      sessionId: "execution-agent-direct-write-session",
      prompt: DIRECT_WRITE_PROMPT,
      historyMessages: [],
      shouldGenerateSessionTitle: true,
      runnerConfig,
      executionPolicySelection: Object.freeze({
        policy: "execution-agent-v1" as const,
        primaryProfileId: "execution-agent-runner-test",
        source: "model_profile" as const,
      }),
      agentMode: "reasoning" as const,
      modelPolicy,
      modelGatewayClient: { invoke, invokeRaw },
      toolPermissionMode: "full_access" as const,
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent,
    } satisfies RequestExecutionSeed;
    const request = createTestRequestExecutionScopeWithCapabilities(
      requestBase,
      (request) =>
        createRequestWorkerCapabilityProvider({
          request,
          executionPolicyAuthority:
            EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
          toolRegistryOverride: toolRegistry,
        }),
      { executionPolicy: EXECUTION_AGENT_V1_EXECUTION_POLICY },
    );

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Created project/direct.txt.",
      outputTextMode: "exact",
    });

    expect(
      invoke.mock.calls.filter(
        ([input]) =>
          input.modelStep === WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
      ),
    ).toHaveLength(1);
    expect(listNormalInvocations).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool.mock.calls[0]?.[0]).toEqual({
      tool: "write_file",
      params: {
        path: "project/direct.txt",
        content: DIRECT_WRITE_BODY,
      },
    });
    expect(
      onEvent.mock.calls.filter(([name]) => name === "tool.payload.started"),
    ).toHaveLength(1);
    expect(
      onEvent.mock.calls.filter(([name]) => name === "tool.payload.completed"),
    ).toHaveLength(1);
    expect(invokeRaw).not.toHaveBeenCalled();
  });

  test("settles a passive stale receipt and redecides without external execution when steering changes during payload authoring", async () => {
    const requestId = "execution-agent-stale-direct-write-request";
    const requestSteering = createRequestSteeringInbox({ requestId });
    expect(
      requestSteering.append({
        steerId: "direct-write-update-1",
        text: "Keep the requested green file content exact.",
      }),
    ).toMatchObject({ ok: true, duplicate: false });
    const registration = directWriteRegistration();
    const executeTool = vi.fn<ToolRegistry["execute"]>(
      async (): Promise<ToolExecutionResult> => ({
        ok: true,
        tool: "write_file",
        output: "Created project/direct.txt.",
        producedNewInformation: true,
        actions: [{ type: "establish_target", target: "project/direct.txt" }],
        data: { mutationEvidence: true },
      }),
    );
    const toolRegistry = directWriteRegistry({
      registration,
      listNormalInvocations: vi.fn(() => [registration]),
      execute: executeTool,
    });
    let decisionCount = 0;
    let payloadCount = 0;
    const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const messages = asMessages(input.messages);
      if (input.modelStep === EXECUTION_AGENT_DECISION_MODEL_STEP) {
        const refinement = messages.some(({ content }) => {
          try {
            return (
              (JSON.parse(content) as Record<string, unknown>).kind ===
              "runtime_execution_capability_refinement_v1"
            );
          } catch {
            return false;
          }
        });
        if (refinement) {
          return {
            text: encodeDecision({
              invocations: {
                invocation_1: {
                  disposition: "execute",
                  controls: {},
                },
              },
            }),
            meta: {},
          };
        }
        decisionCount += 1;
        if (decisionCount === 1) {
          return {
            text: encodeDecision({
              action: "open_capability_scope",
              catalogGroupIds: [FILE_GROUP],
              acknowledgement: "I will create the exact requested file.",
            }),
            meta: {},
          };
        }
        if (decisionCount === 2 || decisionCount === 3) {
          if (decisionCount === 3) {
            expect(executeTool).not.toHaveBeenCalled();
            const resultMessages = messages.filter(
              (message) => message.role === "tool",
            );
            const staleReceipt = JSON.parse(
              resultMessages.at(-1)!.content,
            ) as Record<string, unknown>;
            expect(staleReceipt).toMatchObject({
              result: {
                executionId: "capability-execution-1",
                adapterResult: {
                  kind: "runtime_capability_rejection_v1",
                  authority: "runtime",
                  status: "rejected",
                  stage: "before_external_execution",
                  code: "steering_superseded_before_external_execution",
                  message: expect.stringContaining(
                    "steering_superseded_before_external_execution",
                  ),
                },
              },
            });
            const steering = messages.find(({ content }) => {
              try {
                return (
                  (JSON.parse(content) as Record<string, unknown>).kind ===
                  "runtime_active_request_updates_v1"
                );
              } catch {
                return false;
              }
            });
            expect(JSON.parse(steering!.content)).toMatchObject({
              version: 2,
              updates: [
                {
                  sequence: 1,
                  text: "Keep the requested green file content exact.",
                },
                {
                  sequence: 2,
                  text: "Continue with the same exact green content.",
                },
              ],
            });
          }
          return {
            text: encodeDecision({
              action: "invoke_capability",
              capabilityId: "write_complete_file",
              intent: DIRECT_WRITE_INTENT,
              selectionControls: { path: "project/direct.txt" },
              ...(decisionCount === 2 ? { workingDirectory: null } : {}),
            }),
            meta: {},
          };
        }
        if (decisionCount === 4) {
          expect(executeTool).toHaveBeenCalledOnce();
          const resultMessages = messages.filter(
            (message) => message.role === "tool",
          );
          expect(JSON.parse(resultMessages.at(-1)!.content)).toMatchObject({
            result: {
              executionId: "capability-execution-2",
              adapterResult: {
                kind: "registered_tool_execution_result_v1",
                authority: "registered_plugin",
                status: "executed",
                result: { ok: true, tool: "write_file" },
              },
            },
          });
          return { text: encodeDecision({ action: "respond" }), meta: {} };
        }
      }
      if (input.modelStep === WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP) {
        payloadCount += 1;
        const canonical = messages.find(({ content }) =>
          content.startsWith("Canonical runtime context:\n"),
        );
        const context = JSON.parse(
          canonical!.content.replace("Canonical runtime context:\n", ""),
        ) as Record<string, unknown>;
        expect(context).toMatchObject({
          root: {
            steeringVersion: payloadCount,
            updates:
              payloadCount === 1
                ? [
                    {
                      sequence: 1,
                      text: "Keep the requested green file content exact.",
                    },
                  ]
                : [
                    {
                      sequence: 1,
                      text: "Keep the requested green file content exact.",
                    },
                    {
                      sequence: 2,
                      text: "Continue with the same exact green content.",
                    },
                  ],
          },
        });
        if (payloadCount === 1) {
          expect(
            requestSteering.append({
              steerId: "direct-write-update-2",
              text: "Continue with the same exact green content.",
            }),
          ).toMatchObject({ ok: true, duplicate: false });
        }
        return { text: DIRECT_WRITE_BODY, meta: {} };
      }
      if (input.modelStep === EXECUTION_AGENT_RESPONSE_MODEL_STEP) {
        return { text: "Created project/direct.txt.", meta: {} };
      }
      throw new Error(`unexpected model step: ${input.modelStep}`);
    });
    const requestBase = {
      requestId,
      sessionId: "execution-agent-stale-direct-write-session",
      prompt: DIRECT_WRITE_PROMPT,
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      runnerConfig,
      executionPolicySelection: Object.freeze({
        policy: "execution-agent-v1" as const,
        primaryProfileId: "execution-agent-runner-test",
        source: "model_profile" as const,
      }),
      agentMode: "reasoning" as const,
      modelPolicy,
      modelGatewayClient: { invoke, invokeRaw },
      requestSteering,
      toolPermissionMode: "full_access" as const,
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent: vi.fn(),
    } satisfies RequestExecutionSeed;
    const request = createTestRequestExecutionScopeWithCapabilities(
      requestBase,
      (request) =>
        createRequestWorkerCapabilityProvider({
          request,
          executionPolicyAuthority:
            EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
          toolRegistryOverride: toolRegistry,
        }),
      { executionPolicy: EXECUTION_AGENT_V1_EXECUTION_POLICY },
    );

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Created project/direct.txt.",
      outputTextMode: "exact",
    });
    expect(payloadCount).toBe(2);
    expect(decisionCount).toBe(4);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool.mock.calls[0]?.[0]).toEqual({
      tool: "write_file",
      params: {
        path: "project/direct.txt",
        content: DIRECT_WRITE_BODY,
      },
    });
    expect(invokeRaw).not.toHaveBeenCalled();
  });
});

function buildMemoryAuthoredResponse(): string {
  return JSON.stringify({
    finalResponse: EXACT_RESPONSE,
    memoryCandidates: [MEMORY_CANDIDATE],
  });
}

function directWriteRegistration(): RegisteredToolNormalInvocation {
  const operation: ToolNormalInvocationOperation = {
    operationId: "write_complete_file",
    summary: "Write one complete file.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["path"],
    },
    payload: {
      kind: "raw_text",
      param: "content",
      instructions: "Return the complete file body.",
      minBytes: 1,
      maxBytes: 1_024,
    },
    effect: "mutating",
    approval: "request_policy",
  };
  return {
    toolName: "write_file",
    definition: {
      name: "write_file",
      routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      catalogGroups: [FILE_GROUP],
      params: { path: "string", content: "string" },
      payloadChannelSpec: {
        params: ["content"],
        outputParam: "content",
        generationMode: "raw_text",
        targetParam: "path",
        targetRole: "operation_target",
      },
    },
    contract: { version: 1, operations: [operation] },
  };
}

function directWriteRegistry(
  params: Readonly<{
    registration: RegisteredToolNormalInvocation;
    listNormalInvocations: () => readonly RegisteredToolNormalInvocation[];
    execute: ToolRegistry["execute"];
  }>,
): ToolRegistry {
  return {
    listDefinitions: () => [params.registration.definition],
    listNormalInvocations: params.listNormalInvocations,
    getDefinition: (name) =>
      name === params.registration.definition.name
        ? params.registration.definition
        : undefined,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    prepareSharedState: (state = {}) => ({
      ...state,
      runtimePaths: { agentWorkDir: process.cwd() },
    }),
    execute: params.execute,
  };
}
