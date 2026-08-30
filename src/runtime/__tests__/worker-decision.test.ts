import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import type { RequestToolResultsView } from "../context/request-tool-results.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import { type WorkerCapabilityAdapter } from "../orchestration/worker-capabilities/index.js";
import type {
  RequestCapabilityExecutionView,
  RequestExecutionScope,
} from "../request/execution-scope.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  buildWorkerDecisionInput,
  CAPABILITY_CONTROLS_MODEL_STEP,
  createWorkerDecisionFormat,
  GENERIC_WORKER_EXECUTOR,
  parseWorkerDecisionOutput,
  projectWorkerDecisionCallIdentity,
  runWorkerDecision,
  WORKER_DECISION_MODEL_STEP,
  WORKER_RESULT_MODEL_STEP,
  WORKER_RESULT_MAX_LENGTH,
} from "../steps/worker-decision/index.js";

const runnerConfig: RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: "runtime-default",
      steps: {
        [WORKER_DECISION_MODEL_STEP]: "worker.decision",
        [WORKER_RESULT_MODEL_STEP]: "supervisor.response",
        [CAPABILITY_CONTROLS_MODEL_STEP]: "capability.controls",
      },
    },
  },
  context: {
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
  steps: {
    [WORKER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
    [WORKER_RESULT_MODEL_STEP]: { timeoutMs: 20_000 },
    [CAPABILITY_CONTROLS_MODEL_STEP]: { timeoutMs: 20_000 },
  } as RequestRunnerConfig["steps"],
};

const modelPolicy = {
  providers: { local: { type: "ollama" as const } },
  profiles: {
    "runtime-default": {
      provider: "local",
      model: "runtime-default:latest",
      contextWindowTokens: 8_000,
      supportsThinking: true,
      calibration: {
        "worker.decision": {},
      },
    },
  },
  defaults: {
    profileId: "runtime-default",
    steps: {
      [WORKER_DECISION_MODEL_STEP]: "worker.decision",
      [WORKER_RESULT_MODEL_STEP]: "supervisor.response",
      [CAPABILITY_CONTROLS_MODEL_STEP]: "capability.controls",
    },
  },
};

const operationSupervisionModelPolicy = {
  ...modelPolicy,
  profiles: {
    ...modelPolicy.profiles,
    "runtime-default": {
      ...modelPolicy.profiles["runtime-default"],
      contextWindowTokens: 32_000,
    },
  },
};

const workerCall: RoleCallFrame = Object.freeze({
  callId: "call-2",
  parentCallId: "call-1",
  roleId: "worker",
  depth: 1,
  objective: "Explain why small checkpoints reduce implementation risk.",
  dependencyResultRefs: [],
  status: "active",
  childCallIds: [],
  activationCount: 1,
  resultRef: null,
});

const EMPTY_REQUEST_TOOL_RESULTS: RequestToolResultsView = Object.freeze({
  sourceRevision: 0,
  results: Object.freeze([]),
});
const REQUEST_SOURCE_PROMPT =
  "Write EXACT_WORKER_LITERAL to /tmp/worker target.txt.";

function asChatMessages(input: unknown): readonly ChatMessage[] {
  if (!Array.isArray(input)) throw new Error("expected model messages");
  return input as readonly ChatMessage[];
}

function runtimeMessageByKind(
  input: unknown,
  kind: string,
): Record<string, unknown> {
  const messages = asChatMessages(input);
  const decoded = messages.flatMap(({ content }) => {
    try {
      return [JSON.parse(content) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const message = decoded.find((candidate) => candidate.kind === kind);
  if (!message) throw new Error(`runtime message ${kind} missing`);
  return message;
}

function hasRuntimeMessageKind(input: unknown, kind: string): boolean {
  const messages = asChatMessages(input);
  return messages.some(({ content }) => content.includes(`"kind":"${kind}"`));
}

function modelFormatSchema(
  format: "json" | Record<string, unknown> | undefined,
): unknown {
  return typeof format === "object" && format !== null
    ? format.schema
    : undefined;
}

function requestToolResults(summary: string): RequestToolResultsView {
  return Object.freeze({
    sourceRevision: 7,
    results: Object.freeze([
      Object.freeze({
        executionId: "capability-execution-shared",
        callId: workerCall.callId,
        invocationAttempt: 1,
        capabilityId: "example.observe",
        declaredEffect: "observation",
        outcome: "succeeded",
        observedEffect: "observation",
        summary,
      }),
    ]),
  });
}

async function createWorkerLedger(): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId: "worker-request",
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
  if (!created.ok) throw new Error("root call was not created");
  const opened = await ledger.apply({
    expectedHead: created.head,
    command: {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: workerCall.objective!,
    },
  });
  if (!opened.ok) throw new Error("Worker call was not created");
  return ledger;
}

async function createWorkerWithDependency(): Promise<{
  ledger: RoleCallLedger;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  dependencySummary: string;
}> {
  const ledger = createRoleCallLedger({
    requestId: "worker-request",
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
  const apply = async (command: unknown) => {
    const result = await ledger.apply({
      expectedHead: ledger.current(),
      command,
    });
    if (!result.ok) throw new Error(result.code);
    return result.head;
  };
  await apply({ authority: "runtime", type: "create_root" });
  await apply({
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: "Coordinate one observation followed by one mutation.",
  });
  await apply({
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-2",
    roleId: "worker",
    objective: "Observe the current source state.",
    plannerPlan: {
      mode: "declare",
      plan: {
        summary: "Observe the source state, then perform the mutation.",
        items: [
          {
            title: "Observe source state",
            objective: "Observe the current source state.",
          },
          {
            title: "Perform mutation",
            objective:
              "Use the established source state and perform the mutation.",
          },
        ],
      },
      selectedItemIndexes: [0],
    },
  });
  const dependencySummary =
    "DEPENDENCY_SUMMARY_SECRET: the current source state is established.";
  await apply({
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-2",
    childCallId: "call-3",
    outcome: "completed",
    summary: dependencySummary,
  });
  const head = await apply({
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-2",
    roleId: "worker",
    objective: "Use the established source state and perform the mutation.",
    dependencyResultRefs: ["result-1"],
    plannerPlan: {
      mode: "select",
      itemIds: ["plan-call-2-item-2"],
    },
  });
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("dependent Worker call missing");
  return { ledger, head, call, dependencySummary };
}

function createRequest(
  invoke: ModelGatewayClient["invoke"] = vi.fn(async (input) => ({
    text:
      input.modelStep === WORKER_RESULT_MODEL_STEP
        ? "Small checkpoints expose incorrect assumptions early."
        : workerDecisionText({ action: "return_result" }),
    meta: {},
  })),
): RequestExecutionScope {
  return createTestRequestExecutionScope({
    requestId: "worker-request",
    sessionId: "worker-session",
    prompt: REQUEST_SOURCE_PROMPT,
    historyMessages: [
      {
        id: "history-secret",
        role: "user",
        content: "HISTORY_MUST_NOT_REACH_WORKER",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
    ],
    shouldGenerateSessionTitle: false,
    runnerConfig,
    attachments: [
      {
        id: "attachment-secret",
        kind: "image",
        name: "ATTACHMENT_MUST_NOT_REACH_WORKER",
        mimeType: "image/png",
        storageRef: "attachments/ATTACHMENT_CONTENT_MUST_NOT_REACH_WORKER",
        data: "ATTACHMENT_CONTENT_MUST_NOT_REACH_WORKER",
      },
    ],
    agentMode: "reasoning",
    modelPolicy,
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
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
  });
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

function workerDecisionText(decision: unknown): string {
  return JSON.stringify({ decision });
}

describe("generic Worker no-tool decision contract", () => {
  test("publishes exact result and failure schema variants", () => {
    expect(createWorkerDecisionFormat()).toMatchObject({
      type: "json_schema",
      name: "worker_decision",
      strict: true,
      postValidatedSchemaConstraints: [
        {
          keyword: "maxLength",
          path: "/properties/decision/anyOf/1/properties/reason/maxLength",
        },
      ],
      schema: {
        type: "object",
        properties: {
          decision: {
            anyOf: [
              {
                properties: {
                  action: { enum: ["return_result"] },
                },
                required: ["action"],
                additionalProperties: false,
              },
              {
                properties: {
                  action: { enum: ["return_failure"] },
                  reason: {
                    type: "string",
                    minLength: 1,
                    maxLength: WORKER_RESULT_MAX_LENGTH,
                  },
                },
                required: ["action", "reason"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["decision"],
        additionalProperties: false,
      },
    });
  });

  test("parses and freezes the result selection and truthful failures", () => {
    const result = parseWorkerDecisionOutput(
      workerDecisionText({ action: "return_result" }),
    );
    const failure = parseWorkerDecisionOutput(
      workerDecisionText({
        action: "return_failure",
        reason: "  Current external state is unavailable.  ",
      }),
    );

    expect(result).toEqual({
      ok: true,
      decision: {
        action: "return_result",
      },
    });
    expect(failure).toEqual({
      ok: true,
      decision: {
        action: "return_failure",
        reason: "Current external state is unavailable.",
      },
    });
    if (result.ok) expect(Object.isFrozen(result.decision)).toBe(true);
    if (failure.ok) expect(Object.isFrozen(failure.decision)).toBe(true);
  });

  test("rejects invalid envelopes, legacy actions, extra fields, and bad bounds", () => {
    expect(parseWorkerDecisionOutput("not-json")).toMatchObject({
      ok: false,
      stage: "json_envelope",
      issues: [{ code: "worker_output_not_json", path: "decision" }],
    });
    expect(
      parseWorkerDecisionOutput(JSON.stringify({ action: "return_result" })),
    ).toMatchObject({
      ok: false,
      stage: "json_envelope",
      issues: [{ code: "worker_output_envelope_invalid", path: "decision" }],
    });
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "complete_item",
          itemId: "item-1",
          status: "completed",
          output: "Legacy output.",
        }),
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [{ code: "worker_action_invalid", path: "decision.action" }],
    });
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "return_result",
          result: "Result prose belongs to the raw authoring step.",
          progress: "done",
        }),
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "worker_decision_shape_invalid", path: "decision" }],
    });
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({ action: "return_failure", reason: "   " }),
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "worker_result_invalid", path: "decision.reason" }],
    });
  });

  test("requires one active non-root Worker child frame", () => {
    expect(projectWorkerDecisionCallIdentity(workerCall)).toEqual({
      callId: "call-2",
      parentCallId: "call-1",
      depth: 1,
      invocationAttempt: 1,
    });
    for (const invalid of [
      { ...workerCall, roleId: "planner" as const },
      { ...workerCall, parentCallId: null, depth: 0 },
      { ...workerCall, status: "completed" as const },
      { ...workerCall, objective: null },
      { ...workerCall, resultRef: "result-1" },
    ]) {
      expect(() => projectWorkerDecisionCallIdentity(invalid)).toThrow(
        "worker_call_frame_invalid",
      );
    }
  });

  test("projects only the exact assignment capsule and bounded diagnostics", () => {
    configureDebugLogger({ enabled: true });
    const objective = "OBJECTIVE_SECRET_AVAILABLE_ONLY_IN_MODEL_CONTEXT";
    const methodology = "SUPERVISOR_ONLY_METHODOLOGY_MUST_NOT_REACH_WORKER";
    const baseRequest = createRequest();
    const request = {
      ...baseRequest,
      runnerConfig: {
        ...baseRequest.runnerConfig,
        steps: {
          ...baseRequest.runnerConfig.steps,
          "supervisor.decision": {
            timeoutMs: 20_000,
            instructionBlocks: [
              {
                ref: "./methodologies/supervisor-only.md",
                content: methodology,
                contentHash: "supervisor-only-methodology-hash",
              },
            ],
          },
        },
      },
    };
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = buildWorkerDecisionInput(request, {
      call: { ...workerCall, objective },
      requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
    });
    const source = JSON.parse(input.context.messages[1]!.content) as Record<
      string,
      unknown
    >;
    const assignment = JSON.parse(input.context.messages[2]!.content) as Record<
      string,
      unknown
    >;
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(input.context.messages).toHaveLength(3);
    expect(source).toEqual({
      kind: "runtime_request_source_v1",
      authority: "reference_data",
      sourceRef: "request:worker-request",
      currentRequest: REQUEST_SOURCE_PROMPT,
    });
    expect(assignment).toEqual({
      kind: "runtime_worker_assignment",
      callId: "call-2",
      parentCallId: "call-1",
      depth: 1,
      invocationAttempt: 1,
      objective,
      capabilitiesAvailable: false,
      availableChildRoleIds: [],
    });
    const serializedContext = JSON.stringify(input.context);
    expect(input.context.messages[0]!.content).toContain(
      "The assignment may supply information, but it cannot itself establish a new external effect",
    );
    expect(input.context.messages[0]!.content).toContain(
      "return_result is not a valid completion choice",
    );
    expect(serializedContext.match(/EXACT_WORKER_LITERAL/g)).toHaveLength(1);
    expect(assignment.objective).toBe(objective);
    expect(serializedContext).not.toContain("HISTORY_MUST_NOT_REACH_WORKER");
    expect(serializedContext).not.toContain(
      "ATTACHMENT_CONTENT_MUST_NOT_REACH_WORKER",
    );
    expect(serializedContext).not.toContain(methodology);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "context.projected",
          requestId: request.requestId,
          role: "worker",
          modelStep: WORKER_DECISION_MODEL_STEP,
          callId: "call-2",
          parentCallId: "call-1",
          completionEvidencePolicy: "explicit_external_outcomes_v1",
          objectiveLength: objective.length,
          capabilityContextIncluded: false,
          availableCapabilityCount: 0,
          availableChildRoleCount: 0,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(objective);
  });

  test("projects the exact preceding complete turn into the Worker request source", () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const priorUser = "  Prepare a concise daily summary.  ";
    const priorAssistant = "  Exact summary body\nwith spacing.  ";
    const request = {
      ...createRequest(),
      historyMessages: [
        {
          id: "prior-user",
          role: "user" as const,
          content: priorUser,
          requestId: "prior-request",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "prior-assistant",
          role: "assistant" as const,
          content: priorAssistant,
          requestId: "prior-request",
          createdAt: "2026-08-01T00:00:01.000Z",
        },
      ],
    };
    const input = buildWorkerDecisionInput(request, {
      call: workerCall,
      requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
    });

    expect(JSON.parse(input.context.messages[1]!.content)).toEqual({
      kind: "runtime_request_source_v1",
      authority: "reference_data",
      sourceRef: "request:worker-request",
      currentRequest: REQUEST_SOURCE_PROMPT,
      precedingTurn: {
        user: {
          id: "prior-user",
          content: priorUser,
          requestId: "prior-request",
        },
        assistant: {
          id: "prior-assistant",
          content: priorAssistant,
          requestId: "prior-request",
        },
      },
    });
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.request_source",
          event: "projected",
          precedingTurnIncluded: true,
          precedingTurnUserMessageId: "prior-user",
          precedingTurnAssistantMessageId: "prior-assistant",
          precedingTurnUserChars: priorUser.length,
          precedingTurnAssistantChars: priorAssistant.length,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(priorUser);
    expect(JSON.stringify(logs)).not.toContain(priorAssistant);
  });

  test("resolves selected role results into the dependent Worker assignment", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, head, call, dependencySummary } =
      await createWorkerWithDependency();
    const configuredInstruction = "CONFIGURED_WORKER_EXECUTION_INSTRUCTION";
    const baseRequest = createRequest();
    const request = {
      ...baseRequest,
      runnerConfig: {
        ...baseRequest.runnerConfig,
        steps: {
          ...baseRequest.runnerConfig.steps,
          [WORKER_DECISION_MODEL_STEP]: {
            ...baseRequest.runnerConfig.steps[WORKER_DECISION_MODEL_STEP],
            instructionBlocks: [
              {
                ref: "./worker-execution.md",
                content: configuredInstruction,
                contentHash: "worker-execution-hash",
              },
            ],
          },
        },
      },
    };
    const input = buildWorkerDecisionInput(request, {
      call,
      requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      capabilitySource: {
        ledger,
        head,
        binding: Object.freeze({
          requestId: request.requestId,
          ledger,
          callId: call.callId,
          invocationAttempt: call.activationCount,
          capabilities: Object.freeze([]),
        }),
      },
    });
    const assignmentScope = JSON.parse(
      input.context.messages[2]!.content,
    ) as Record<string, unknown>;
    const assignment = JSON.parse(input.context.messages[3]!.content) as {
      dependencyResults: unknown[];
    };
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(assignmentScope).toEqual({
      kind: "runtime_role_call_assignment_scope_v1",
      authority: "reference_data",
      sourceRevision: head.revision,
      scopeCallId: "call-2",
      scopeRoleId: "planner",
      scopeObjective: "Coordinate one observation followed by one mutation.",
    });
    expect(assignment.dependencyResults).toEqual([
      {
        resultRef: "result-1",
        producerCallId: "call-3",
        roleId: "worker",
        outcome: "completed",
        summary: dependencySummary,
      },
    ]);
    expect(input.context.messages[0]!.content).toContain(
      "do not repeat that observation merely to rediscover it",
    );
    expect(input.context.messages[0]!.content).toContain(
      "runtime_role_call_assignment_scope_v1 is read-only continuity data",
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "context.projected",
          roleDependencyContextIncluded: true,
          dependencyResultCount: 1,
          dependencyResultRefs: ["result-1"],
          dependencyResultSummaryLength: dependencySummary.length,
          roleAssignmentScopeIncluded: true,
          roleAssignmentScopeCallId: "call-2",
          roleAssignmentScopeRoleId: "planner",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(dependencySummary);

    const executionInput = buildWorkerDecisionInput(request, {
      call,
      requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      capabilitySource: {
        ledger,
        head,
        binding: Object.freeze({
          requestId: request.requestId,
          ledger,
          callId: call.callId,
          invocationAttempt: call.activationCount,
          capabilities: Object.freeze([
            Object.freeze({
              capabilityId: "example.mutate",
              summary: "Perform one bounded mutation.",
              effect: "mutation" as const,
              catalogGroups: Object.freeze(["write"]),
              controls: Object.freeze({
                type: "object" as const,
                additionalProperties: false as const,
                properties: Object.freeze({}),
                required: Object.freeze([]),
              }),
            }),
          ]),
        }),
      },
      selectedCapabilityExecution: {
        capabilityId: "example.mutate",
        intent: "Apply the established state.",
        guidance: "SELECTED_EXECUTION_GUIDANCE",
      },
    });
    expect(executionInput.modelStep).toBe(CAPABILITY_CONTROLS_MODEL_STEP);
    expect(executionInput.allowedActions).toEqual([
      "return_failure",
      "invoke_capability",
    ]);
    expect(JSON.stringify(executionInput.format.schema)).not.toContain(
      "return_result",
    );
    expect(
      runtimeMessageByKind(
        executionInput.context.messages,
        "runtime_role_call_assignment_scope_v1",
      ),
    ).toEqual(assignmentScope);
    expect(
      runtimeMessageByKind(
        executionInput.context.messages,
        "runtime_worker_capability_execution_assignment",
      ),
    ).toMatchObject({ dependencyResults: assignment.dependencyResults });
    expect(executionInput.context.messages[0]!.content).not.toContain(
      configuredInstruction,
    );
    expect(executionInput.context.messages[0]!.content).toContain(
      "SELECTED_EXECUTION_GUIDANCE",
    );
  });

  test("selects completion in JSON, authors the result as raw text, and logs no content", async () => {
    configureDebugLogger({ enabled: true });
    const secretResult = "RESULT_SECRET_SHOULD_NOT_BE_LOGGED";
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      if (invocationIndex === 1) {
        expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
        expect(input.format).toMatchObject({
          type: "json_schema",
          name: "worker_decision",
          strict: true,
        });
        return {
          text: workerDecisionText({ action: "return_result" }),
          meta: {},
        };
      }
      expect(input.modelStep).toBe(WORKER_RESULT_MODEL_STEP);
      expect(input).not.toHaveProperty("format");
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      expect(messages[0]!.content).toContain("Return only the raw result text");
      expect(messages[0]!.content).toContain(
        "The role result is the semantic delta for the caller",
      );
      expect(messages[0]!.content).toContain(
        "Do not copy, quote, dump, or substantially restate tool-result summaries",
      );
      expect(messages).toHaveLength(3);
      expect(JSON.parse(messages[1]!.content)).toEqual({
        kind: "runtime_request_source_v1",
        authority: "reference_data",
        sourceRef: "request:worker-request",
        currentRequest: REQUEST_SOURCE_PROMPT,
      });
      expect(JSON.parse(messages[2]!.content)).toEqual({
        kind: "runtime_worker_result_assignment",
        callId: workerCall.callId,
        parentCallId: workerCall.parentCallId,
        depth: workerCall.depth,
        invocationAttempt: workerCall.activationCount,
        objective: workerCall.objective,
      });
      expect(messages[2]!.content).not.toContain("availableCapabilities");
      expect(messages[2]!.content).not.toContain("pendingCapabilitySelection");
      return { text: `  ${secretResult}  `, meta: {} };
    });
    const request = createRequest(invoke);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runWorkerDecision(request, {
        call: workerCall,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      }),
    ).resolves.toEqual({
      action: "return_result",
      result: secretResult,
    });
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      WORKER_DECISION_MODEL_STEP,
      WORKER_RESULT_MODEL_STEP,
    ]);
    expect(request.onThinkingTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        step: WORKER_DECISION_MODEL_STEP,
        status: "completed",
      }),
    );
    expect(request.onThinkingTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        step: WORKER_RESULT_MODEL_STEP,
        status: "completed",
      }),
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "output.envelope.accepted",
          validationStage: "json_envelope",
        }),
        expect.objectContaining({
          scope: "runtime.worker",
          event: "decision.accepted",
          validationStage: "domain_parser",
          selectedAction: "return_result",
          mappedOutcome: "result_authoring_required",
        }),
        expect.objectContaining({
          scope: "runtime.worker",
          event: "model.completed",
          mappedOutcome: "result_authoring_required",
        }),
        expect.objectContaining({
          scope: "runtime.worker",
          event: "result.context.projected",
          modelStep: WORKER_RESULT_MODEL_STEP,
        }),
        expect.objectContaining({
          scope: "runtime.worker",
          event: "result.model.completed",
          modelStep: WORKER_RESULT_MODEL_STEP,
          resultLength: secretResult.length,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(secretResult);
  });

  test("projects one request tool-results block into decision and result without duplicating its summary", async () => {
    const sharedSummary = "SHARED_TOOL_SUMMARY_MUST_APPEAR_ONCE";
    const sharedView = requestToolResults(sharedSummary);
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      const capsules = messages.flatMap((message) => {
        try {
          const parsed = JSON.parse(message.content) as unknown;
          return typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
            ? [parsed as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
      const resultBlocks = capsules.filter(
        ({ kind }) => kind === "runtime_request_tool_results_v1",
      );
      expect(resultBlocks).toHaveLength(1);
      expect(
        messages.filter(({ content }) => content.includes(sharedSummary)),
      ).toHaveLength(1);
      expect(
        JSON.stringify(resultBlocks[0]).split(sharedSummary).length - 1,
      ).toBe(1);
      expect(JSON.stringify(messages)).not.toContain(
        '"kind":"runtime_capability_result"',
      );

      if (input.modelStep === WORKER_DECISION_MODEL_STEP) {
        expect(
          capsules.find(({ kind }) => kind === "runtime_worker_assignment"),
        ).not.toHaveProperty("settledCapabilityResults");
        return {
          text: workerDecisionText({ action: "return_result" }),
          meta: {},
        };
      }
      expect(input.modelStep).toBe(WORKER_RESULT_MODEL_STEP);
      expect(
        capsules.find(
          ({ kind }) => kind === "runtime_worker_result_assignment",
        ),
      ).not.toHaveProperty("settledCapabilityResults");
      return {
        text: "The shared observation was consumed from capability-execution-1.",
        meta: {},
      };
    });

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call: workerCall,
        requestToolResults: sharedView,
      }),
    ).resolves.toEqual({
      action: "return_result",
      result:
        "The shared observation was consumed from capability-execution-1.",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("rejects an empty raw result with result-author diagnostics", async () => {
    configureDebugLogger({ enabled: true });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => ({
      text:
        input.modelStep === WORKER_RESULT_MODEL_STEP
          ? "   "
          : workerDecisionText({ action: "return_result" }),
      meta: {},
    }));
    const request = createRequest(invoke);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runWorkerDecision(request, {
        call: workerCall,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      }),
    ).rejects.toThrow("invalid_worker_result");

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.model",
          event: "step.repair.started",
          modelStep: WORKER_RESULT_MODEL_STEP,
          sameRoleCall: true,
        }),
        expect.objectContaining({
          scope: "runtime.model",
          event: "step.repair.exhausted",
          modelStep: WORKER_RESULT_MODEL_STEP,
          repeatedInvalidOutput: true,
        }),
        expect.objectContaining({
          scope: "runtime.worker",
          event: "result.model.failed",
          modelStep: WORKER_RESULT_MODEL_STEP,
          errorType: "Error",
        }),
      ]),
    );
    expect(logs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "model.failed",
          modelStep: WORKER_DECISION_MODEL_STEP,
        }),
      ]),
    );
  });

  test("repairs one oversized raw result in the same Worker result step", async () => {
    configureDebugLogger({ enabled: true });
    const oversizedResult = "x".repeat(WORKER_RESULT_MAX_LENGTH + 1);
    const repairedResult =
      "Created the requested project files and verified the requested behavior.";
    let resultAttempt = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep === WORKER_DECISION_MODEL_STEP) {
        return {
          text: workerDecisionText({ action: "return_result" }),
          meta: {},
        };
      }
      resultAttempt += 1;
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      if (resultAttempt === 1) {
        return { text: oversizedResult, meta: {} };
      }
      expect(messages.at(-1)).toMatchObject({ role: "system" });
      expect(messages.at(-1)!.content).toContain("worker_result_too_long");
      expect(messages.at(-1)!.content).toContain(
        `at most ${WORKER_RESULT_MAX_LENGTH} characters`,
      );
      expect(JSON.stringify(messages)).not.toContain(oversizedResult);
      return { text: repairedResult, meta: {} };
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call: workerCall,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      }),
    ).resolves.toEqual({
      action: "return_result",
      result: repairedResult,
    });
    expect(invoke).toHaveBeenCalledTimes(3);

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.model",
          event: "step.invalid_output",
          modelStep: WORKER_RESULT_MODEL_STEP,
          issues: [{ code: "worker_result_too_long", path: "result" }],
          outputLength: WORKER_RESULT_MAX_LENGTH + 1,
        }),
        expect.objectContaining({
          scope: "runtime.model",
          event: "step.repair.succeeded",
          modelStep: WORKER_RESULT_MODEL_STEP,
          repairAttempts: 1,
          sameRoleCall: true,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(oversizedResult);
  });

  test("surfaces an explicitly truncated raw result without role completion", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      if (input.modelStep !== WORKER_RESULT_MODEL_STEP) {
        return {
          text: workerDecisionText({ action: "return_result" }),
          meta: {},
        };
      }
      return {
        text: "A result cut off before it became complete...",
        meta: { providerCompletionReason: "length" },
      };
    });

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call: workerCall,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      }),
    ).rejects.toMatchObject({
      name: "ModelOutputIncompleteError",
      code: "output_incomplete",
      providerCompletionReason: "length",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("maps Worker result and failure decisions to mechanical role outcomes", async () => {
    const ledger = await createWorkerLedger();
    const canonicalCall = ledger
      .current()
      .state.calls.find(
        (candidate) => candidate.callId === ledger.current().state.activeCallId,
      );
    if (!canonicalCall) throw new Error("canonical Worker call missing");
    const completedRequest = createRequest(
      vi.fn(async (input) => ({
        text:
          input.modelStep === WORKER_RESULT_MODEL_STEP
            ? "The requested bounded result."
            : workerDecisionText({ action: "return_result" }),
        meta: {},
      })),
    );
    await expect(
      GENERIC_WORKER_EXECUTOR.execute({
        context: completedRequest,
        call: canonicalCall,
        ledger,
        availableChildRoleIds: [],
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "The requested bounded result.",
    });

    const failedInvoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: workerDecisionText({
        action: "return_failure",
        reason: "A current external observation is required.",
      }),
      meta: {},
    }));
    const failedRequest = createRequest(failedInvoke);
    await expect(
      GENERIC_WORKER_EXECUTOR.execute({
        context: failedRequest,
        call: canonicalCall,
        ledger,
        availableChildRoleIds: [],
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "failed",
      summary: "A current external observation is required.",
    });
    expect(failedInvoke).toHaveBeenCalledOnce();
  });

  test("merges controls with the frozen single-capability selection and does not carry guidance into re-entry", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const skillSecret =
      "SELECTED_SKILL_CONTEXT_MUST_EXIST_ONLY_BEFORE_EXECUTION";
    const canonicalIntent = 'Observe the exact "current" value.';
    const timeline: string[] = [];
    const ledger = await createWorkerLedger();
    const firstCall = ledger
      .current()
      .state.calls.find(
        (candidate) => candidate.callId === ledger.current().state.activeCallId,
      );
    if (!firstCall) throw new Error("canonical Worker call missing");

    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
      descriptor: {
        capabilityId: "example.observe",
        summary: "Observe one exact current value.",
        effect: "observation",
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: 4_096,
            },
          },
          required: ["query"],
        },
      },
      execute: vi.fn(async ({ controls, intent }) => {
        timeline.push("tool.execute");
        expect(intent).toBe(canonicalIntent);
        expect(controls).toEqual({ query: "refined cobalt value" });
        return {
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: "Observed value: cobalt.",
        };
      }),
    };
    let modelInvocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      modelInvocation += 1;
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      const serializedMessages = JSON.stringify(messages);
      if (modelInvocation === 1) {
        timeline.push("model.selection");
        expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
        expect(serializedMessages).not.toContain(skillSecret);
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "example.observe",
            intent: canonicalIntent,
          }),
          meta: {},
        };
      }
      if (modelInvocation === 2) {
        timeline.push("model.execution");
        expect(input.modelStep).toBe(CAPABILITY_CONTROLS_MODEL_STEP);
        expect(serializedMessages).toContain(skillSecret);
        expect(JSON.stringify(input.format)).not.toContain('"capabilityId"');
        expect(JSON.stringify(input.format)).not.toContain('"intent"');
        expect(JSON.stringify(input.format)).not.toContain(
          JSON.stringify(canonicalIntent),
        );
        const capsule = runtimeMessageByKind(
          messages,
          "runtime_worker_capability_execution_assignment",
        );
        expect(capsule).toMatchObject({
          selectedCapabilityAffordances: [
            {
              capabilityId: "example.observe",
              summary: "Observe one exact current value.",
              effect: "observation",
            },
          ],
          pendingCapabilitySelection: {
            capabilityId: "example.observe",
          },
        });
        expect(JSON.stringify(capsule)).not.toContain(canonicalIntent);
        expect(capsule).not.toHaveProperty("capabilitiesAvailable");
        expect(capsule).not.toHaveProperty("availableChildRoleIds");
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            controls: { query: "refined cobalt value" },
          }),
          meta: {},
        };
      }
      if (modelInvocation === 3) {
        timeline.push("model.reentry");
        expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
        expect(serializedMessages).not.toContain(skillSecret);
        expect(
          hasRuntimeMessageKind(
            messages,
            "runtime_worker_capability_execution_assignment",
          ),
        ).toBe(false);
        return {
          text: workerDecisionText({ action: "return_result" }),
          meta: {},
        };
      }
      timeline.push("model.result");
      expect(input.modelStep).toBe(WORKER_RESULT_MODEL_STEP);
      expect(input).not.toHaveProperty("format");
      expect(serializedMessages).not.toContain(skillSecret);
      return { text: "The exact observed value is cobalt.", meta: {} };
    });
    const getExecutionGuidance = vi.fn(async (capabilityId: string) => {
      timeline.push(`skill.load:${capabilityId}`);
      return skillSecret;
    });
    const request = createTestRequestExecutionScope({
      ...createRequest(invoke),
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([adapter.descriptor]),
        getExecutionGuidance,
        getAdapters: () => Object.freeze([adapter]),
      },
    });

    const firstResult = await GENERIC_WORKER_EXECUTOR.execute({
      context: request,
      call: firstCall,
      ledger,
      availableChildRoleIds: [],
    });
    expect(firstResult).toEqual({
      kind: "continue",
      continuation: {
        kind: "capability_execution",
        executionId: "capability-execution-1",
      },
    });
    if (
      firstResult.kind !== "continue" ||
      firstResult.continuation.kind !== "capability_execution"
    ) {
      throw new Error("expected capability continuation");
    }
    const resumedCall = ledger
      .current()
      .state.calls.find((candidate) => candidate.callId === firstCall.callId);
    if (!resumedCall) throw new Error("resumed Worker call missing");

    await expect(
      GENERIC_WORKER_EXECUTOR.execute({
        context: request,
        call: resumedCall,
        ledger,
        availableChildRoleIds: [],
        continuation: firstResult.continuation,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "The exact observed value is cobalt.",
    });

    expect(getExecutionGuidance).toHaveBeenCalledExactlyOnceWith(
      "example.observe",
    );
    expect(timeline).toEqual([
      "model.selection",
      "skill.load:example.observe",
      "model.execution",
      "tool.execute",
      "model.reentry",
      "model.result",
    ]);
    expect(request.onThinkingDelta).toHaveBeenCalledExactlyOnceWith(
      `${canonicalIntent}\n\n`,
    );
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "client_intent.published",
          decisionPhase: "capability_execution",
          capabilityId: "example.observe",
          intentLength: canonicalIntent.length,
          intentSource: "capability_selection",
        }),
      ]),
    );
    const publishedIntent = logs.find(
      ({ event }) => event === "client_intent.published",
    );
    expect(publishedIntent).not.toHaveProperty("guidanceDecisionIntentLength");
    expect(publishedIntent).not.toHaveProperty("guidanceDecisionIntentChanged");
  });

  test("preserves a fully frozen runtime path selection when no registry exists", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const ledger = await createWorkerLedger();
    const call = ledger
      .current()
      .state.calls.find(
        (candidate) => candidate.callId === ledger.current().state.activeCallId,
      );
    if (!call) throw new Error("canonical Worker call missing");
    const canonicalIntent = "Create the requested product data file.";
    const authoringObjective =
      "Create the complete product data JSON document requested by the Worker.";
    const execute = vi.fn<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
    >(async ({ context, controls, intent, authoringObjective: assignment }) => {
      expect(context).not.toHaveProperty("sessionArtifactPaths");
      expect(intent).toBe(canonicalIntent);
      expect(assignment).toBe(authoringObjective);
      expect(controls).toEqual({ path: "products.json" });
      return {
        outcome: "succeeded" as const,
        observedEffect: "mutation" as const,
        summary: "Created the selected product data file.",
      };
    });
    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
      descriptor: {
        capabilityId: "write_complete_file",
        summary: "Write one complete file.",
        effect: "mutation",
        controlsRefinement: "mechanical_when_complete",
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4_096 },
          },
          required: ["path"],
        },
        selectionControlIds: ["path"],
        runtimePathControlIds: ["path"],
        requiresPayloadAuthoringObjective: true,
      },
      execute,
    };
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const serializedFormat = JSON.stringify(modelFormatSchema(input.format));
      const serializedMessages = JSON.stringify(input.messages);
      expect(serializedFormat).toContain('"selectionControls"');
      expect(serializedFormat).toContain('"authoringObjective"');
      expect(serializedFormat).toContain('"path"');
      expect(serializedMessages).not.toContain(
        "runtime_session_artifact_paths_v1",
      );
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          capabilityId: "write_complete_file",
          intent: canonicalIntent,
          authoringObjective,
          selectionControls: { path: "products.json" },
        }),
        meta: {},
      };
    });
    const getExecutionGuidance = vi.fn(async () => "   ");
    const request = createTestRequestExecutionScope({
      ...createRequest(invoke),
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([adapter.descriptor]),
        getExecutionGuidance,
        getAdapters: () => Object.freeze([adapter]),
      },
    });

    await expect(
      GENERIC_WORKER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: [],
      }),
    ).resolves.toEqual({
      kind: "continue",
      continuation: {
        kind: "capability_execution",
        executionId: "capability-execution-1",
      },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(getExecutionGuidance).toHaveBeenCalledExactlyOnceWith(
      "write_complete_file",
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(request.onThinkingDelta).toHaveBeenCalledExactlyOnceWith(
      `${canonicalIntent}\n\n`,
    );

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "decision.accepted",
          decisionPhase: "capability_selection",
          capabilityId: "write_complete_file",
          selectionControlsIncluded: true,
          selectionControlKeyCount: 1,
          controlsIncluded: false,
        }),
        expect.objectContaining({
          scope: "runtime.worker",
          event: "capability_refinement.skipped",
          decisionPhase: "capability_execution",
          capabilityId: "write_complete_file",
          reason: "selection_controls_complete",
          selectionControlCount: 1,
          remainingControlCount: 0,
          executionGuidanceIncluded: false,
        }),
      ]),
    );
    expect(
      logs.filter(
        ({ scope, event, decisionPhase }) =>
          scope === "runtime.worker" &&
          event === "model.started" &&
          decisionPhase === "capability_execution",
      ),
    ).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain("products.json");
  });

  test("keeps a selected non-path capability on the baseline one-call path when a registry exists", async () => {
    const ledger = await createWorkerLedger();
    const call = ledger
      .current()
      .state.calls.find(
        (candidate) => candidate.callId === ledger.current().state.activeCallId,
      );
    if (!call) throw new Error("canonical Worker call missing");
    const canonicalIntent = "Look up the requested release summary.";
    const queryControls = Object.freeze({ query: "runtime release summary" });
    const pathExecute = vi.fn<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
    >(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "mutation" as const,
      summary: "Wrote the selected file.",
    }));
    const queryExecute = vi.fn<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
    >(async ({ context, controls, intent }) => {
      expect(context).not.toHaveProperty("sessionArtifactPaths");
      expect(intent).toBe(canonicalIntent);
      expect(controls).toEqual(queryControls);
      return {
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "Found the requested release summary.",
      };
    });
    const pathAdapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
      {
        descriptor: {
          capabilityId: "write_complete_file",
          summary: "Write one complete file.",
          effect: "mutation",
          controlsRefinement: "mechanical_when_complete",
          controls: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string", minLength: 1, maxLength: 4_096 },
            },
            required: ["path"],
          },
          selectionControlIds: ["path"],
          runtimePathControlIds: ["path"],
        },
        execute: pathExecute,
      };
    const queryAdapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
      {
        descriptor: {
          capabilityId: "lookup_release_summary",
          summary: "Look up one release summary.",
          effect: "observation",
          controlsRefinement: "mechanical_when_complete",
          controls: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", minLength: 1, maxLength: 4_096 },
            },
            required: ["query"],
          },
          selectionControlIds: ["query"],
        },
        execute: queryExecute,
      };
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      expect(input.modelStep).toBe(WORKER_DECISION_MODEL_STEP);
      expect(
        hasRuntimeMessageKind(
          input.messages,
          "runtime_session_artifact_paths_v1",
        ),
      ).toBe(false);
      expect(JSON.stringify(input.messages)).not.toContain("news/news.txt");
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          capabilityId: queryAdapter.descriptor.capabilityId,
          intent: canonicalIntent,
          selectionControls: queryControls,
        }),
        meta: {},
      };
    });
    const getExecutionGuidance = vi.fn(async () => "");
    const request = createTestRequestExecutionScope({
      ...createRequest(invoke),
      sessionArtifactPaths: Object.freeze(["news/news.txt"]),
      workerCapabilityProvider: {
        getDescriptors: () =>
          Object.freeze([pathAdapter.descriptor, queryAdapter.descriptor]),
        getExecutionGuidance,
        getAdapters: () => Object.freeze([pathAdapter, queryAdapter]),
      },
    });

    await expect(
      GENERIC_WORKER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: [],
      }),
    ).resolves.toEqual({
      kind: "continue",
      continuation: {
        kind: "capability_execution",
        executionId: "capability-execution-1",
      },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(getExecutionGuidance).toHaveBeenCalledExactlyOnceWith(
      queryAdapter.descriptor.capabilityId,
    );
    expect(queryExecute).toHaveBeenCalledOnce();
    expect(pathExecute).not.toHaveBeenCalled();
  });

  test("defers runtime path authoring and projects only eligible newest registry paths", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const ledger = await createWorkerLedger();
    const call = ledger
      .current()
      .state.calls.find(
        (candidate) => candidate.callId === ledger.current().state.activeCallId,
      );
    if (!call) throw new Error("canonical Worker call missing");
    const canonicalIntent = "Update the previously established artifact.";
    const sessionArtifactPaths = Object.freeze(
      Array.from({ length: 10 }, (_, index) => `artifact-${index}.txt`),
    );
    const execute = vi.fn<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
    >(async ({ context, controls, intent }) => {
      expect(context).not.toHaveProperty("sessionArtifactPaths");
      expect(intent).toBe(canonicalIntent);
      expect(controls).toEqual({ path: "artifact-0.txt" });
      return {
        outcome: "succeeded" as const,
        observedEffect: "mutation" as const,
        summary: "Updated the selected artifact.",
      };
    });
    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
      descriptor: {
        capabilityId: "write_complete_file",
        summary: "Write one complete file.",
        effect: "mutation",
        controlsRefinement: "mechanical_when_complete",
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4_096 },
          },
          required: ["path"],
        },
        selectionControlIds: ["path"],
        runtimePathControlIds: ["path"],
      },
      execute,
    };
    let invocationIndex = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocationIndex += 1;
      const serializedFormat = JSON.stringify(modelFormatSchema(input.format));
      if (invocationIndex === 1) {
        expect(serializedFormat).not.toContain('"selectionControls"');
        expect(
          hasRuntimeMessageKind(
            input.messages,
            "runtime_session_artifact_paths_v1",
          ),
        ).toBe(false);
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "write_complete_file",
            intent: canonicalIntent,
          }),
          meta: {},
        };
      }
      expect(invocationIndex).toBe(2);
      expect(serializedFormat).not.toContain('"selectionControls"');
      const capsule = runtimeMessageByKind(
        input.messages,
        "runtime_session_artifact_paths_v1",
      );
      expect(capsule).toMatchObject({
        applicability:
          "selected_capability_runtime_path_control_authoring_refinement_only",
        targets: sessionArtifactPaths.slice(0, 8),
        omission: {
          availableTargetCount: 10,
          projectedTargetCount: 8,
          omittedTargetCount: 2,
        },
      });
      expect(
        asChatMessages(input.messages).findIndex(({ content }) =>
          content.includes('"kind":"runtime_session_artifact_paths_v1"'),
        ),
      ).toBe(1);
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          controls: { path: "artifact-0.txt" },
        }),
        meta: {},
      };
    });
    const getExecutionGuidance = vi.fn(async () => "   ");
    const request = createTestRequestExecutionScope({
      ...createRequest(invoke),
      sessionArtifactPaths,
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([adapter.descriptor]),
        getExecutionGuidance,
        getAdapters: () => Object.freeze([adapter]),
      },
    });

    await expect(
      GENERIC_WORKER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: [],
      }),
    ).resolves.toEqual({
      kind: "continue",
      continuation: {
        kind: "capability_execution",
        executionId: "capability-execution-1",
      },
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(getExecutionGuidance).toHaveBeenCalledExactlyOnceWith(
      "write_complete_file",
    );
    expect(execute).toHaveBeenCalledOnce();

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "context.projected",
          decisionPhase: "capability_selection",
          sessionArtifactPathSelectionDeferred: true,
          sessionArtifactPathAvailableCount: 10,
          sessionArtifactPathBoundedCount: 8,
          sessionArtifactPathEligibleCount: 8,
          sessionArtifactPathProjectedCount: 0,
          sessionArtifactPathOmittedCount: 10,
        }),
        expect.objectContaining({
          scope: "runtime.worker",
          event: "context.projected",
          decisionPhase: "capability_execution",
          sessionArtifactPathSelectionDeferred: false,
          sessionArtifactPathAvailableCount: 10,
          sessionArtifactPathBoundedCount: 8,
          sessionArtifactPathEligibleCount: 8,
          sessionArtifactPathProjectedCount: 8,
          sessionArtifactPathOmittedCount: 2,
        }),
      ]),
    );
    expect(
      logs.some(
        ({ scope, event }) =>
          scope === "runtime.worker" &&
          event === "capability_refinement.skipped",
      ),
    ).toBe(false);
  });

  test("does not defer or refine when every newest registry path is already in current results", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const ledger = await createWorkerLedger();
    const head = ledger.current();
    const call = head.state.calls.find(
      (candidate) => candidate.callId === head.state.activeCallId,
    );
    if (!call) throw new Error("canonical Worker call missing");
    const canonicalIntent = "Reuse the current request target.";
    const descriptor = Object.freeze({
      capabilityId: "write_complete_file",
      summary: "Write one complete file.",
      effect: "mutation" as const,
      controlsRefinement: "mechanical_when_complete" as const,
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
      runtimePathControlIds: Object.freeze(["path"]),
      catalogGroups: Object.freeze(["write" as const]),
    });
    const currentResults: RequestToolResultsView = Object.freeze({
      sourceRevision: head.revision,
      results: Object.freeze([
        Object.freeze({
          executionId: "capability-execution-existing",
          callId: call.callId,
          invocationAttempt: 1,
          capabilityId: "example.existing",
          declaredEffect: "observation" as const,
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: "The current request already carries the exact target.",
          references: Object.freeze([
            Object.freeze({
              kind: "tool_target" as const,
              target: "artifact-current.txt",
            }),
          ]),
        }),
      ]),
    });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      expect(JSON.stringify(modelFormatSchema(input.format))).toContain(
        '"selectionControls"',
      );
      expect(
        hasRuntimeMessageKind(
          input.messages,
          "runtime_session_artifact_paths_v1",
        ),
      ).toBe(false);
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          capabilityId: descriptor.capabilityId,
          intent: canonicalIntent,
          selectionControls: { path: "artifact-current.txt" },
        }),
        meta: {},
      };
    });
    const request = createTestRequestExecutionScope({
      ...createRequest(invoke),
      sessionArtifactPaths: Object.freeze(["artifact-current.txt"]),
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([descriptor]),
        getExecutionGuidance: vi.fn(async () => ""),
        getAdapters: () => Object.freeze([]),
      },
    });

    await expect(
      runWorkerDecision(request, {
        call,
        requestToolResults: currentResults,
        capabilitySource: {
          ledger,
          head,
          binding: Object.freeze({
            requestId: request.requestId,
            ledger,
            callId: call.callId,
            invocationAttempt: call.activationCount,
            capabilities: Object.freeze([descriptor]),
          }),
        },
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: descriptor.capabilityId,
      intent: canonicalIntent,
      controls: { path: "artifact-current.txt" },
    });
    expect(invoke).toHaveBeenCalledOnce();

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "context.projected",
          decisionPhase: "capability_selection",
          sessionArtifactPathSelectionDeferred: false,
          sessionArtifactPathAvailableCount: 1,
          sessionArtifactPathBoundedCount: 1,
          sessionArtifactPathEligibleCount: 0,
          sessionArtifactPathProjectedCount: 0,
          sessionArtifactPathOmittedCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.worker",
          event: "capability_refinement.skipped",
          capabilityId: descriptor.capabilityId,
        }),
      ]),
    );
  });

  test("defers batch runtime paths and resumes with every heterogeneous result", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const intentA = 'Inspect project "A".';
    const intentB = 'Inspect JSON "B".';
    const ledger = await createWorkerLedger();
    const firstCall = ledger
      .current()
      .state.calls.find(
        (candidate) => candidate.callId === ledger.current().state.activeCallId,
      );
    if (!firstCall) throw new Error("canonical Worker call missing");
    const projectAdapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
      {
        descriptor: {
          capabilityId: "inspect_project",
          summary: "Inspect one bounded project tree.",
          effect: "observation",
          controls: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: {
                type: "string",
                minLength: 0,
                maxLength: 1_024,
              },
              depth: { type: "integer", minimum: 0, maximum: 6 },
              maxEntries: { type: "integer", minimum: 1, maximum: 500 },
            },
            required: ["path"],
          },
          selectionControlIds: ["path"],
          runtimePathControlIds: ["path"],
        },
        execute: vi.fn(async ({ controls, settledCapabilityResults }) => ({
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: `Inspected project ${String(controls.path)} with ${settledCapabilityResults.length} prior results.`,
        })),
      };
    const jsonAdapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> =
      {
        descriptor: {
          capabilityId: "inspect_json",
          summary: "Inspect one bounded JSON file.",
          effect: "observation",
          controls: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: {
                type: "string",
                minLength: 1,
                maxLength: 1_024,
              },
              maxDepth: { type: "integer", minimum: 0, maximum: 6 },
            },
            required: ["path"],
          },
          selectionControlIds: ["path"],
          runtimePathControlIds: ["path"],
        },
        execute: vi.fn(async ({ controls, settledCapabilityResults }) => ({
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: `Inspected JSON ${String(controls.path)} with ${settledCapabilityResults.length} prior results.`,
        })),
      };
    let modelInvocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      modelInvocation += 1;
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      const serializedFormat = JSON.stringify(input.format);
      if (modelInvocation === 1) {
        expect(serializedFormat).not.toContain('"controls"');
        expect(serializedFormat).not.toContain('"selectionControls"');
        expect(
          hasRuntimeMessageKind(messages, "runtime_session_artifact_paths_v1"),
        ).toBe(false);
        return {
          text: workerDecisionText({
            action: "invoke_capabilities",
            invocations: [
              {
                capabilityId: "inspect_project",
                intent: intentA,
              },
              {
                capabilityId: "inspect_json",
                intent: intentB,
              },
            ],
          }),
          meta: {},
        };
      }
      if (modelInvocation === 2) {
        expect(serializedFormat).toContain('"controls"');
        expect(serializedFormat).not.toContain('"capabilityId"');
        expect(serializedFormat).not.toContain('"intent"');
        expect(serializedFormat).not.toContain(JSON.stringify(intentA));
        expect(serializedFormat).not.toContain(JSON.stringify(intentB));
        expect(serializedFormat).not.toContain("return_result");
        expect(input.format).toMatchObject({
          schema: {
            properties: {
              decision: {
                anyOf: [
                  {},
                  {
                    properties: {
                      invocations: {
                        properties: {
                          invocation_1: {
                            description:
                              expect.stringContaining("inspect_project"),
                            properties: {
                              controls: {
                                properties: {
                                  path: {},
                                  depth: {},
                                  maxEntries: {},
                                },
                              },
                            },
                          },
                          invocation_2: {
                            description:
                              expect.stringContaining("inspect_json"),
                            properties: {
                              controls: {
                                properties: { path: {}, maxDepth: {} },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        });
        const capsule = runtimeMessageByKind(
          messages,
          "runtime_worker_capability_execution_assignment",
        );
        expect(capsule).toMatchObject({
          selectedCapabilityAffordances: [
            {
              capabilityId: "inspect_json",
              summary: "Inspect one bounded JSON file.",
              effect: "observation",
            },
            {
              capabilityId: "inspect_project",
              summary: "Inspect one bounded project tree.",
              effect: "observation",
            },
          ],
          pendingCapabilityBatchSelection: [
            {
              capabilityId: "inspect_project",
            },
            {
              capabilityId: "inspect_json",
            },
          ],
        });
        expect(JSON.stringify(capsule)).not.toContain(intentA);
        expect(JSON.stringify(capsule)).not.toContain(intentB);
        expect(capsule).not.toHaveProperty("capabilitiesAvailable");
        expect(capsule).not.toHaveProperty("availableChildRoleIds");
        expect(
          runtimeMessageByKind(messages, "runtime_session_artifact_paths_v1"),
        ).toMatchObject({
          targets: ["AbotMarketScopeLuna20260810T1624Z/products.json"],
        });
        return {
          text: workerDecisionText({
            action: "invoke_capabilities",
            invocations: {
              invocation_1: {
                controls: {
                  path: "AbotMarketScopeLuna20260810T1624Z",
                  depth: 2,
                  maxEntries: 100,
                },
              },
              invocation_2: {
                controls: {
                  path: "AbotMarketScopeLuna20260810T1624Z/products.json",
                  maxDepth: 2,
                },
              },
            },
          }),
          meta: {},
        };
      }
      if (modelInvocation === 3) {
        const serialized = JSON.stringify(messages);
        expect(serialized).toContain("capability-execution-1");
        expect(serialized).toContain("capability-execution-2");
        expect(
          hasRuntimeMessageKind(
            messages,
            "runtime_worker_capability_execution_assignment",
          ),
        ).toBe(false);
        return {
          text: workerDecisionText({ action: "return_result" }),
          meta: {},
        };
      }
      expect(input.modelStep).toBe(WORKER_RESULT_MODEL_STEP);
      return { text: "Both independent sources were observed.", meta: {} };
    });
    const getExecutionGuidance = vi.fn(async (capabilityId: string) =>
      capabilityId === "inspect_project" ? "PROJECT_GUIDANCE" : "JSON_GUIDANCE",
    );
    const request = createTestRequestExecutionScope({
      ...createRequest(invoke),
      sessionArtifactPaths: Object.freeze([
        "AbotMarketScopeLuna20260810T1624Z/products.json",
      ]),
      workerCapabilityProvider: {
        getDescriptors: () =>
          Object.freeze([jsonAdapter.descriptor, projectAdapter.descriptor]),
        getExecutionGuidance,
        getAdapters: () => Object.freeze([jsonAdapter, projectAdapter]),
      },
    });

    const firstResult = await GENERIC_WORKER_EXECUTOR.execute({
      context: request,
      call: firstCall,
      ledger,
      availableChildRoleIds: [],
    });
    expect(firstResult).toEqual({
      kind: "continue",
      continuation: {
        kind: "capability_batch_execution",
        executionIds: ["capability-execution-1", "capability-execution-2"],
      },
    });
    if (
      firstResult.kind !== "continue" ||
      firstResult.continuation.kind !== "capability_batch_execution"
    ) {
      throw new Error("expected capability batch continuation");
    }
    expect(ledger.current().state.capabilityExecutions).toEqual([
      expect.objectContaining({
        invocationAttempt: 1,
        status: "settled",
        summary:
          "Inspected project AbotMarketScopeLuna20260810T1624Z with 0 prior results.",
      }),
      expect.objectContaining({
        invocationAttempt: 1,
        status: "settled",
        summary:
          "Inspected JSON AbotMarketScopeLuna20260810T1624Z/products.json with 0 prior results.",
      }),
    ]);
    const resumedCall = ledger
      .current()
      .state.calls.find((candidate) => candidate.callId === firstCall.callId);
    if (!resumedCall) throw new Error("resumed Worker call missing");

    await expect(
      GENERIC_WORKER_EXECUTOR.execute({
        context: request,
        call: resumedCall,
        ledger,
        availableChildRoleIds: [],
        continuation: firstResult.continuation,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Both independent sources were observed.",
    });
    expect(getExecutionGuidance).toHaveBeenCalledTimes(2);
    expect(getExecutionGuidance).toHaveBeenNthCalledWith(1, "inspect_project");
    expect(getExecutionGuidance).toHaveBeenNthCalledWith(2, "inspect_json");
    expect(projectAdapter.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        intent: intentA,
        controls: {
          path: "AbotMarketScopeLuna20260810T1624Z",
          depth: 2,
          maxEntries: 100,
        },
      }),
    );
    expect(jsonAdapter.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        intent: intentB,
        controls: {
          path: "AbotMarketScopeLuna20260810T1624Z/products.json",
          maxDepth: 2,
        },
      }),
    );
    expect(request.onThinkingDelta).toHaveBeenCalledExactlyOnceWith(
      `${intentA}\n${intentB}\n\n`,
    );
    expect(invoke).toHaveBeenCalledTimes(4);
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(
      logs.filter(
        ({ scope, event, modelStep }) =>
          scope === "runtime.model" &&
          modelStep === WORKER_DECISION_MODEL_STEP &&
          (event === "step.invalid_output" || event === "step.repair.started"),
      ),
    ).toEqual([]);
  });

  test("coalesces exact batches into the single lane and maps their persistent limit to failure", async () => {
    const ledger = await createWorkerLedger();
    const call = ledger
      .current()
      .state.calls.find(
        (candidate) => candidate.callId === ledger.current().state.activeCallId,
      );
    if (!call) throw new Error("canonical Worker call missing");
    const preparedExecute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Observed one exact materialized operation.",
    }));
    const directExecute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Legacy execution must not run.",
    }));
    const prepare = vi.fn<
      NonNullable<
        WorkerCapabilityAdapter<RequestCapabilityExecutionView>["prepare"]
      >
    >(async ({ controls }) =>
      Object.freeze({
        actionFingerprint: `sha256:${"b".repeat(64)}`,
        acceptedControls: controls,
        execute: preparedExecute,
      }),
    );
    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
      descriptor: {
        capabilityId: "example.observe",
        summary: "Observe one exact bounded query.",
        effect: "observation",
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: { type: "string", minLength: 1, maxLength: 64 },
            query: { type: "string", minLength: 1, maxLength: 64 },
          },
          required: ["source", "query"],
        },
        selectionControlIds: ["source"],
      },
      prepare,
      execute: directExecute,
    };
    let modelInvocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
      modelInvocation += 1;
      return modelInvocation % 2 === 1
        ? {
            text: workerDecisionText({
              action: "invoke_capabilities",
              invocations: [
                {
                  capabilityId: "example.observe",
                  intent: "Observe the bounded source.",
                  selectionControls: { source: "A" },
                },
                {
                  capabilityId: "example.observe",
                  intent: "Observe the same bounded source again.",
                  selectionControls: { source: "A" },
                },
              ],
            }),
            meta: {},
          }
        : {
            text: workerDecisionText({
              action: "invoke_capabilities",
              invocations: {
                invocation_1: { controls: { query: "same" } },
                invocation_2: { controls: { query: "same" } },
              },
            }),
            meta: {},
          };
    });
    const request = createTestRequestExecutionScope({
      ...createRequest(invoke),
      modelPolicy: operationSupervisionModelPolicy,
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([adapter.descriptor]),
        getExecutionGuidance: vi.fn(async () => ""),
        getAdapters: () => Object.freeze([adapter]),
      },
    });

    const first = await GENERIC_WORKER_EXECUTOR.execute({
      context: request,
      call,
      ledger,
      availableChildRoleIds: [],
    });
    expect(first).toEqual({
      kind: "continue",
      continuation: {
        kind: "capability_execution",
        executionId: "capability-execution-1",
      },
    });
    if (
      first.kind !== "continue" ||
      first.continuation.kind !== "capability_execution"
    ) {
      throw new Error("coalesced capability continuation missing");
    }
    const activeCall = () => {
      const head = ledger.current();
      const current = head.state.calls.find(
        (candidate) => candidate.callId === head.state.activeCallId,
      );
      if (!current) throw new Error("canonical Worker call missing");
      return current;
    };
    const second = await GENERIC_WORKER_EXECUTOR.execute({
      context: request,
      call: activeCall(),
      ledger,
      availableChildRoleIds: [],
      continuation: first.continuation,
    });
    expect(second).toMatchObject({
      kind: "continue",
      continuation: {
        kind: "capability_execution",
        executionId: "capability-execution-2",
      },
    });
    if (
      second.kind !== "continue" ||
      second.continuation.kind !== "capability_execution"
    ) {
      throw new Error("second coalesced capability continuation missing");
    }
    const intervention = await GENERIC_WORKER_EXECUTOR.execute({
      context: request,
      call: activeCall(),
      ledger,
      availableChildRoleIds: [],
      continuation: second.continuation,
    });
    expect(intervention).toMatchObject({
      kind: "continue",
      continuation: { kind: "operation_supervision_intervention" },
    });
    if (
      intervention.kind !== "continue" ||
      intervention.continuation.kind !== "operation_supervision_intervention"
    ) {
      throw new Error("batch operation supervision continuation missing");
    }
    await expect(
      GENERIC_WORKER_EXECUTOR.execute({
        context: request,
        call: activeCall(),
        ledger,
        availableChildRoleIds: [],
        continuation: intervention.continuation,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "failed",
      summary:
        "The runtime stopped a persistently repeated operation after intervention.",
    });

    expect(prepare).toHaveBeenCalledTimes(8);
    expect(preparedExecute).toHaveBeenNthCalledWith(
      1,
      "capability-execution-1",
    );
    expect(preparedExecute).toHaveBeenNthCalledWith(
      2,
      "capability-execution-2",
    );
    expect(directExecute).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toHaveLength(2);
  });

  test("projects warning and intervention receipts while keeping the Worker on its role", async () => {
    const ledger = await createWorkerLedger();
    const preparedExecute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Observed the exact same value.",
    }));
    const prepare = vi.fn<
      NonNullable<
        WorkerCapabilityAdapter<RequestCapabilityExecutionView>["prepare"]
      >
    >(async ({ controls }) =>
      Object.freeze({
        actionFingerprint: `sha256:${"c".repeat(64)}`,
        acceptedControls: controls,
        execute: preparedExecute,
      }),
    );
    const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
      descriptor: {
        capabilityId: "example.observe",
        summary: "Observe one exact bounded query.",
        effect: "observation",
        controlsRefinement: "mechanical_when_complete",
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 64 },
          },
          required: ["query"],
        },
        selectionControlIds: ["query"],
      },
      prepare,
      execute: vi.fn(async () => {
        throw new Error("legacy execution must not run");
      }),
    };
    let modelInvocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      modelInvocation += 1;
      const assignment = runtimeMessageByKind(
        input.messages as readonly Readonly<{ content: string }>[],
        "runtime_worker_assignment",
      );
      if (modelInvocation === 3) {
        expect(assignment.operationSupervision).toEqual([
          expect.objectContaining({
            kind: "runtime_operation_supervision_v1",
            stage: "warning",
            originExecutionId: "capability-execution-2",
          }),
        ]);
      } else if (modelInvocation === 4) {
        expect(assignment.operationSupervision).toEqual([
          expect.objectContaining({
            kind: "runtime_operation_supervision_v1",
            stage: "intervention",
            originExecutionId: "capability-execution-2",
          }),
        ]);
      } else {
        expect(assignment).not.toHaveProperty("operationSupervision");
      }
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          capabilityId: "example.observe",
          intent: "Observe the bounded value.",
          selectionControls: { query: "same" },
        }),
        meta: {},
      };
    });
    const request = createTestRequestExecutionScope({
      ...createRequest(invoke),
      modelPolicy: operationSupervisionModelPolicy,
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([adapter.descriptor]),
        getExecutionGuidance: vi.fn(async () => ""),
        getAdapters: () => Object.freeze([adapter]),
      },
    });
    const activeCall = () => {
      const head = ledger.current();
      const call = head.state.calls.find(
        (candidate) => candidate.callId === head.state.activeCallId,
      );
      if (!call) throw new Error("canonical Worker call missing");
      return call;
    };

    const first = await GENERIC_WORKER_EXECUTOR.execute({
      context: request,
      call: activeCall(),
      ledger,
      availableChildRoleIds: [],
    });
    if (
      first.kind !== "continue" ||
      first.continuation.kind !== "capability_execution"
    ) {
      throw new Error("first capability continuation missing");
    }
    const second = await GENERIC_WORKER_EXECUTOR.execute({
      context: request,
      call: activeCall(),
      ledger,
      availableChildRoleIds: [],
      continuation: first.continuation,
    });
    if (
      second.kind !== "continue" ||
      second.continuation.kind !== "capability_execution"
    ) {
      throw new Error("second capability continuation missing");
    }
    const intervention = await GENERIC_WORKER_EXECUTOR.execute({
      context: request,
      call: activeCall(),
      ledger,
      availableChildRoleIds: [],
      continuation: second.continuation,
    });
    expect(intervention).toMatchObject({
      kind: "continue",
      continuation: {
        kind: "operation_supervision_intervention",
        commit: {
          effect: { type: "operation_supervision_intervened" },
        },
      },
    });
    if (
      intervention.kind !== "continue" ||
      intervention.continuation.kind !== "operation_supervision_intervention"
    ) {
      throw new Error("operation supervision continuation missing");
    }

    await expect(
      GENERIC_WORKER_EXECUTOR.execute({
        context: request,
        call: activeCall(),
        ledger,
        availableChildRoleIds: [],
        continuation: intervention.continuation,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "failed",
      summary:
        "The runtime stopped a persistently repeated operation after intervention.",
    });
    expect(preparedExecute).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(4);
    expect(modelInvocation).toBe(4);
  });
});
