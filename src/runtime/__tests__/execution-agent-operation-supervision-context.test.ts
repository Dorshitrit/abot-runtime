import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import { OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND } from "../context/operation-supervision-evidence.js";
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
import type { ModelGatewayClient } from "../ports.js";
import type { RequestCapabilityExecutionView } from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import {
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  EXECUTION_AGENT_RESPONSE_MODEL_STEP,
  EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
} from "../steps/execution-agent/index.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

const FILE_GROUP = "files";
const TARGET_PATH = "project/index.html";
const REQUEST_PROMPT = `Update ${TARGET_PATH} and preserve the exact result.`;
const OPERATION_OBJECTIVE = `Apply only the requested update to ${TARGET_PATH}.`;
const ACTION_FINGERPRINT = `sha256:${"a".repeat(64)}`;

const descriptor: WorkerCapabilityDescriptor = Object.freeze({
  capabilityId: "files.edit_exact",
  summary: "Edit one exact file.",
  effect: "mixed",
  controls: Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties: Object.freeze({
      path: Object.freeze({
        type: "string" as const,
        minLength: 1,
        maxLength: 4_096,
      }),
      content: Object.freeze({
        type: "string" as const,
        minLength: 1,
        maxLength: 4_096,
      }),
    }),
    required: Object.freeze(["path", "content"]),
  }),
  selectionControlIds: Object.freeze(["path"]),
  runtimePathControlIds: Object.freeze(["path"]),
  catalogGroups: Object.freeze([FILE_GROUP]),
});

const runnerConfig: RequestRunnerConfig = Object.freeze({
  models: Object.freeze({
    defaults: Object.freeze({
      profileId: "execution-agent-operation-supervision-context-test",
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
    [EXECUTION_AGENT_DECISION_MODEL_STEP]: Object.freeze({ timeoutMs: 20_000 }),
    [EXECUTION_AGENT_RESPONSE_MODEL_STEP]: Object.freeze({ timeoutMs: 20_000 }),
    [CAPABILITY_CONTROLS_MODEL_STEP]: Object.freeze({ timeoutMs: 20_000 }),
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
    "execution-agent-operation-supervision-context-test": Object.freeze({
      provider: "local",
      model: "execution-agent-operation-supervision-context-test:latest",
      contextWindowTokens: 32_000,
    }),
  }),
  defaults: runnerConfig.models.defaults,
});

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Execution Agent operation supervision context", () => {
  test("keeps exact native results beside warning and intervention notices", async () => {
    const exactResults = [
      "exact-adapter-result-one",
      "exact-adapter-result-two",
    ] as const;
    let executionCount = 0;
    const executedControls: unknown[] = [];
    const execute = vi.fn<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
    >(async (input) => {
      const exactResult = exactResults[executionCount];
      if (!exactResult) throw new Error("unexpected adapter execution");
      executionCount += 1;
      executedControls.push(input.controls);
      return {
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: exactResult,
        referenceData: `${exactResult}-reference`,
      };
    });
    const prepare = vi.fn<
      NonNullable<
        WorkerCapabilityAdapter<RequestCapabilityExecutionView>["prepare"]
      >
    >(async (input) => {
      const { preparationId: _preparationId, ...executionInput } = input;
      return Object.freeze({
        actionFingerprint: ACTION_FINGERPRINT,
        acceptedControls: input.controls,
        execute: async (executionId: string) =>
          execute(Object.freeze({ ...executionInput, executionId })),
      });
    });
    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
      Object.freeze({ descriptor, prepare, execute });
    let invocationIndex = 0;
    let warningSecondResult = "";
    let warningFingerprint = "";
    const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      const messages = asMessages(input.messages);
      switch (invocationIndex) {
        case 1:
          return decision({
            action: "open_capability_scope",
            catalogGroupIds: [FILE_GROUP],
            acknowledgement: "I will update the exact file.",
          });
        case 2:
          expect(
            collectPropertySchemas(input.format, "selectionControls"),
          ).not.toHaveLength(0);
          return invokeCapabilityDecision(true);
        case 3:
          expectSelectionBoundRefinement(input.format, messages);
          return refinementDecision("first body");
        case 4:
          expectOperationSupervisionContext(messages, undefined, 1);
          return invokeCapabilityDecision(false);
        case 5:
          expectSelectionBoundRefinement(input.format, messages);
          return refinementDecision("first body");
        case 6: {
          const warning = expectOperationSupervisionContext(
            messages,
            "warning",
            2,
          );
          const resultMessages = warning.results;
          warningFingerprint = warning.fingerprint;
          warningSecondResult = resultMessages[1]!.content;
          expect(JSON.parse(warningSecondResult)).toMatchObject({
            kind: EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
            invocationAttempt: 3,
            result: {
              executionId: "capability-execution-2",
              capabilityId: descriptor.capabilityId,
              adapterResult: {
                status: "executed",
                payload: {
                  outcome: "succeeded",
                  observedEffect: "observation",
                  summary: exactResults[1],
                  referenceData: `${exactResults[1]}-reference`,
                },
              },
            },
          });
          return invokeCapabilityDecision(false);
        }
        case 7:
          expectSelectionBoundRefinement(input.format, messages);
          return refinementDecision("first body");
        case 8: {
          const intervention = expectOperationSupervisionContext(
            messages,
            "intervention",
            2,
          );
          const resultMessages = intervention.results;
          expect(intervention.fingerprint).toBe(warningFingerprint);
          expect(resultMessages[1]!.content).toBe(warningSecondResult);
          return decision({ action: "respond" });
        }
        case 9:
          expect(input.modelStep).toBe(EXECUTION_AGENT_RESPONSE_MODEL_STEP);
          expectOperationSupervisionContext(messages, "intervention", 2, true);
          return { text: "Updated the exact file.", meta: {} };
        default:
          throw new Error(`unexpected model invocation: ${invocationIndex}`);
      }
    });
    const onEvent = vi.fn();
    const request = createTestRequestExecutionScope({
      requestId: "execution-agent-operation-supervision-context-request",
      sessionId: "execution-agent-operation-supervision-context-session",
      prompt: REQUEST_PROMPT,
      historyMessages: [],
      sessionArtifactPaths: Object.freeze([TARGET_PATH]),
      shouldGenerateSessionTitle: false,
      runnerConfig,
      executionPolicySelection: Object.freeze({
        policy: "execution-agent-v1" as const,
        primaryProfileId: "execution-agent-operation-supervision-context-test",
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
      onEvent,
    });

    await expect(runRequestRunner(request)).resolves.toEqual({
      output: "Updated the exact file.",
      outputTextMode: "exact",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(executedControls).toEqual([
      { path: TARGET_PATH, content: "first body" },
      { path: TARGET_PATH, content: "first body" },
    ]);
    expect(invokeRaw).not.toHaveBeenCalled();
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain(
      OPERATION_OBJECTIVE,
    );
  });
});

function invokeCapabilityDecision(includeWorkingDirectory: boolean) {
  return decision({
    action: "invoke_capability",
    capabilityId: descriptor.capabilityId,
    intent: "Apply the exact requested update.",
    operationObjective: OPERATION_OBJECTIVE,
    selectionControls: { path: TARGET_PATH },
    ...(includeWorkingDirectory ? { workingDirectory: null } : {}),
  });
}

function refinementDecision(content: string) {
  return decision({
    invocations: {
      invocation_1: {
        disposition: "execute",
        controls: { content },
      },
    },
  });
}

function decision(value: unknown) {
  return { text: JSON.stringify({ decision: value }), meta: {} };
}

function asMessages(value: unknown): readonly ChatMessage[] {
  validateModelGatewayMessages(value);
  if (!Array.isArray(value)) throw new Error("expected model messages");
  return value as readonly ChatMessage[];
}

function expectSelectionBoundRefinement(
  format: unknown,
  messages: readonly ChatMessage[],
): void {
  const assignment = messages
    .filter(({ role }) => role === "user")
    .map(({ content }) => {
      try {
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find(
      (value) => value?.kind === "runtime_execution_capability_refinement_v1",
    );
  expect(assignment).toMatchObject({
    invocations: [
      {
        capabilityId: descriptor.capabilityId,
        operationObjective: OPERATION_OBJECTIVE,
        selectionControls: { path: TARGET_PATH },
        remainingControls: {
          required: ["content"],
          properties: {
            content: {
              type: "string",
              minLength: 1,
              maxLength: 4_096,
            },
          },
        },
      },
    ],
  });
  expect(messages.find(({ role }) => role === "system")?.content).toContain(
    "sole semantic authority",
  );
  expect(collectPropertySchemas(format, "path")).toHaveLength(0);
  expect(collectPropertySchemas(format, "content")).not.toHaveLength(0);
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

function expectOperationSupervisionContext(
  messages: readonly ChatMessage[],
  stage: "warning" | "intervention" | undefined,
  expectedResultCount: number,
  presentation = false,
): Readonly<{
  results: readonly Extract<ChatMessage, { role: "tool" }>[];
  fingerprint: string;
}> {
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
  if (!state) throw new Error("execution state missing");
  if (stage === undefined || presentation) {
    expect(state).not.toHaveProperty("operationSupervision");
  } else {
    expect(state).toMatchObject({
      operationSupervision: [
        {
          kind: "runtime_operation_supervision_v1",
          authority: "runtime_state",
          presenceEffect: "passive_mechanical_intervention_not_user_intent",
          stage,
          actionFingerprint: ACTION_FINGERPRINT,
          priorOutcome: "succeeded",
          outcomeFingerprint: "succeeded",
          matchingOutcomeCount: 2,
          interventionCount: stage === "warning" ? 0 : 1,
        },
      ],
    });
  }
  const notices = state.operationSupervision as
    | readonly Record<string, unknown>[]
    | undefined;
  const evidence = messages
    .filter(({ role }) => role === "user")
    .map(({ content }) => {
      try {
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find(
      (value) => value?.kind === OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
    );
  if (stage === undefined) {
    expect(evidence).toBeUndefined();
  } else {
    expect(typeof state.callId).toBe("string");
    expect(typeof state.activationCount).toBe("number");
    expect(evidence).toMatchObject({
      kind: OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
      binding: {
        callId: state.callId,
        invocationAttempt: state.activationCount,
        consumers: ["activation_decision", "immediate_presentation_handoff"],
      },
      entries: [
        {
          originExecutionId: "capability-execution-2",
          notice: {
            stage,
            originExecutionId: "capability-execution-2",
            actionFingerprint: ACTION_FINGERPRINT,
          },
          evidence: {
            kind: "existing_exact_capability_result_lane",
            executionId: "capability-execution-2",
          },
        },
      ],
    });
    expect(JSON.stringify(evidence)).not.toContain("adapterResult");
    expect(JSON.stringify(evidence)).not.toContain("exact-adapter-result-two");
  }
  const evidenceEntries = evidence?.entries as
    | readonly Record<string, unknown>[]
    | undefined;
  const evidenceNotice = evidenceEntries?.[0]?.notice as
    | Record<string, unknown>
    | undefined;
  const fingerprint =
    evidenceNotice?.actionFingerprint ?? notices?.[0]?.actionFingerprint;
  if (stage !== undefined) {
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  }
  const results = messages.filter(
    (message): message is Extract<ChatMessage, { role: "tool" }> =>
      message.role === "tool",
  );
  expect(results).toHaveLength(expectedResultCount);
  expect(results.map(({ toolCallId }) => toolCallId)).toEqual(
    Array.from(
      { length: expectedResultCount },
      (_, index) => `capability-execution-${index + 1}`,
    ),
  );
  return Object.freeze({
    results,
    fingerprint: typeof fingerprint === "string" ? fingerprint : "",
  });
}
