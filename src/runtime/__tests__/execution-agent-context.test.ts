import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import { OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND } from "../context/operation-supervision-evidence.js";
import { LONG_TERM_MEMORY_MESSAGE_KIND } from "../long-term-memory/projection.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  createRoleCapabilityBinding,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import type {
  RequestCapabilityExecutionView,
  RequestExecutionScope,
} from "../request/execution-scope.js";
import {
  createTestRequestExecutionScope,
  type TestRequestSeed,
} from "./support/request-execution-scope.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import {
  buildExecutionAgentInput,
  buildExecutionAgentResponseInput,
  buildExecutionContinuationMessages,
  buildExecutionDecisionStateMessage,
  EXECUTION_AGENT_ACTION_MESSAGE_KIND,
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  EXECUTION_CAPABILITY_CATALOG_MESSAGE_KIND,
  EXECUTION_CAPABILITY_GROUP_CATALOG_MESSAGE_KIND,
  EXECUTION_CAPABILITY_RECONSIDERATION_MESSAGE_KIND,
  EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
  EXECUTION_CAPABILITY_TOOL_NAME,
  EXECUTION_STATE_MESSAGE_KIND,
} from "../steps/execution-agent/index.js";

const REQUEST_ID = "execution-agent-context-request";
const REQUEST_PROMPT = "CURRENT_EXECUTION_REQUEST_EXACT_ONCE";
const FILE_GROUP = "files";
const WEB_GROUP = "web";

const pathControls = Object.freeze({
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
});
const observePrimary: WorkerCapabilityDescriptor = Object.freeze({
  capabilityId: "files.observe_primary",
  summary: "Observe the primary file.",
  effect: "observation" as const,
  controls: pathControls,
  selectionControlIds: Object.freeze(["path"]),
  controlsRefinement: "mechanical_when_complete" as const,
  catalogGroups: Object.freeze([FILE_GROUP]),
  routingCapability: "filesystem_inspection",
  developmentRoles: Object.freeze(["inspect", "verify"] as const),
});
const observeSecondary: WorkerCapabilityDescriptor = Object.freeze({
  capabilityId: "files.observe_secondary",
  summary: "Observe the secondary file.",
  effect: "observation" as const,
  controls: pathControls,
  selectionControlIds: Object.freeze(["path"]),
  controlsRefinement: "mechanical_when_complete" as const,
  catalogGroups: Object.freeze([FILE_GROUP]),
});

const webLookup: WorkerCapabilityDescriptor = Object.freeze({
  capabilityId: "web.lookup",
  summary: "Look up one web resource.",
  effect: "observation" as const,
  controls: Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties: Object.freeze({}),
    required: Object.freeze([]),
  }),
  catalogGroups: Object.freeze([WEB_GROUP]),
});

const descriptors = Object.freeze([
  observePrimary,
  observeSecondary,
  webLookup,
]);

const runnerConfig: RequestRunnerConfig = Object.freeze({
  models: Object.freeze({
    defaults: Object.freeze({
      profileId: "execution-agent-context-test",
      steps: Object.freeze({
        [EXECUTION_AGENT_DECISION_MODEL_STEP]: "execution.decision",
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
  }),
});

const modelPolicy = Object.freeze({
  providers: Object.freeze({
    local: Object.freeze({ type: "ollama" as const }),
  }),
  profiles: Object.freeze({
    "execution-agent-context-test": Object.freeze({
      provider: "local",
      model: "execution-agent-context-test:latest",
      contextWindowTokens: 32_000,
    }),
  }),
  defaults: Object.freeze({
    profileId: "execution-agent-context-test",
    steps: Object.freeze({
      [EXECUTION_AGENT_DECISION_MODEL_STEP]: "execution.decision",
    }),
  }),
});

function createRequest(
  requestedDescriptors: readonly WorkerCapabilityDescriptor[] = descriptors,
  overrides: Partial<TestRequestSeed> = {},
): Readonly<{
  request: RequestExecutionScope;
  getDescriptors: ReturnType<typeof vi.fn>;
}> {
  const getDescriptors = vi.fn(() => requestedDescriptors);
  return Object.freeze({
    getDescriptors,
    request: createTestRequestExecutionScope({
      requestId: REQUEST_ID,
      sessionId: "execution-agent-context-session",
      prompt: REQUEST_PROMPT,
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      runnerConfig,
      executionPolicySelection: Object.freeze({
        policy: "execution-agent-v1" as const,
        primaryProfileId: "execution-agent-context-test",
        source: "model_profile" as const,
      }),
      agentMode: "reasoning",
      modelPolicy,
      modelGatewayClient: {
        invoke: vi.fn(),
        invokeRaw: vi.fn(),
      },
      workerCapabilityProvider: {
        getDescriptors,
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
    }),
  });
}

async function createRootLedger(
  catalogGroupIds?: readonly string[],
  authority: ExecutionPolicyAuthoritySnapshot = EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId: REQUEST_ID,
    policy: {
      authority,
      limits: {
        maxDepth: 12,
        maxCalls: 48,
        maxCapabilityExecutions: 96,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  if (catalogGroupIds) {
    const head = ledger.current();
    const call = activeRootCall(head);
    await commit(ledger, {
      authority: "active_role",
      type: "update_capability_scope",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      mode: "open",
      catalogGroupIds,
    });
  }
  return ledger;
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`role call commit rejected: ${result.code}`);
  return result.head;
}

function activeRootCall(head: RoleCallLedgerHead): RoleCallFrame {
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("active root call missing");
  return call;
}

function buildInput(request: RequestExecutionScope, ledger: RoleCallLedger) {
  const head = ledger.current();
  return buildExecutionAgentInput(request, {
    head,
    call: activeRootCall(head),
    steeringSnapshot: createRequestSteeringInbox({
      requestId: request.requestId,
    }).snapshot(),
    includeAcknowledgement: false,
    includeTitle: false,
    allowPlanner: true,
    allowAuditor: true,
  });
}

function parseRuntimeMessage(
  messages: readonly ChatMessage[],
  kind: string,
): Record<string, unknown> | undefined {
  for (const message of messages) {
    if (message.role === "tool" || !message.content) continue;
    try {
      const decoded = JSON.parse(message.content) as unknown;
      if (
        typeof decoded === "object" &&
        decoded !== null &&
        !Array.isArray(decoded) &&
        (decoded as Record<string, unknown>).kind === kind
      ) {
        return decoded as Record<string, unknown>;
      }
    } catch {
      // Non-JSON user/history text is expected.
    }
  }
  return undefined;
}

function expectOneCurrentRequest(messages: readonly ChatMessage[]): number {
  expect(
    messages.filter(
      (message) =>
        message.role === "user" && message.content === REQUEST_PROMPT,
    ),
  ).toHaveLength(1);
  return messages.findIndex(
    (message) => message.role === "user" && message.content === REQUEST_PROMPT,
  );
}

function createAdapter(
  descriptor: WorkerCapabilityDescriptor,
  result: Awaited<
    ReturnType<
      WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]
    >
  >,
): WorkerCapabilityAdapter<RequestCapabilityExecutionView> {
  return Object.freeze({
    descriptor,
    execute: vi.fn(async () => result),
  });
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Execution Agent bounded context", () => {
  test("projects exhausted controls validation as passive continuity without choosing the next action", async () => {
    const { request } = createRequest([observePrimary]);
    const ledger = await createRootLedger([FILE_GROUP]);
    const before = ledger.current();
    const call = activeRootCall(before);
    const reconsidered = await commit(ledger, {
      authority: "active_role",
      type: "reconsider_capability_selection",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      steeringVersion: 0,
      selection: {
        action: "invoke_capability",
        invocations: [
          {
            capabilityId: observePrimary.capabilityId,
            intent: "Observe the requested file.",
            selectionControlsJson: '{"path":"primary.txt"}',
          },
        ],
        workingDirectory: ".",
        activeCapabilityCatalogGroupIds: [FILE_GROUP],
      },
      cause: {
        kind: "refinement_invalid_output",
        validationStage: "domain_parser",
        issues: [{ code: "refinement_slot_invalid", path: "decision" }],
        repairAttempts: 2,
        repeatedInvalidOutput: true,
      },
    });

    const input = buildInput(request, ledger);
    const state = parseRuntimeMessage(
      input.messages,
      EXECUTION_STATE_MESSAGE_KIND,
    );

    expect(activeRootCall(reconsidered).activationCount).toBe(
      call.activationCount + 1,
    );
    expect(state?.capabilitySelectionReconsideration).toEqual({
      kind: EXECUTION_CAPABILITY_RECONSIDERATION_MESSAGE_KIND,
      authority: "canonical_role_call_ledger",
      presenceEffect: "passive_continuity_not_next_action",
      outcome: "reconsidered_before_execution",
      executionOccurred: false,
      invocationAttempt: call.activationCount,
      steeringVersion: 0,
      fingerprint:
        activeRootCall(reconsidered).lastCapabilitySelectionReconsideration
          ?.fingerprint,
      cause: {
        kind: "refinement_invalid_output",
        validationStage: "domain_parser",
        issues: [{ code: "refinement_slot_invalid", path: "decision" }],
        repairAttempts: 2,
        repeatedInvalidOutput: true,
      },
      selection: {
        action: "invoke_capability",
        invocations: [
          {
            capabilityId: observePrimary.capabilityId,
            selectionControls: { path: "primary.txt" },
          },
        ],
        workingDirectory: ".",
        activeCapabilityCatalogGroupIds: [FILE_GROUP],
      },
    });
    expect(JSON.stringify(state)).not.toContain("Observe the requested file.");
    expectOneCurrentRequest(input.messages);

    const expiredCall = Object.freeze({
      ...activeRootCall(reconsidered),
      activationCount: call.activationCount + 2,
    });
    const expiredState = JSON.parse(
      buildExecutionDecisionStateMessage(reconsidered, expiredCall).content,
    ) as Record<string, unknown>;
    expect(expiredState).not.toHaveProperty(
      "capabilitySelectionReconsideration",
    );
  });

  test("keeps audit available after a prior review when canonical evidence exists", async () => {
    const adapter = createAdapter(observePrimary, {
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Primary file observed.",
    });
    const { request } = createRequest([observePrimary], {
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([observePrimary]),
        getAdapters: () => Object.freeze([adapter]),
      },
    });
    const ledger = await createRootLedger([FILE_GROUP]);
    let head = ledger.current();
    await createRoleCapabilityBinding({
      requestId: request.requestId,
      context: request,
      call: activeRootCall(head),
      ledger,
      adapters: [adapter],
    }).execute({
      capabilityId: observePrimary.capabilityId,
      intent: "Observe the primary file.",
      controls: { path: "primary.txt" },
    });
    head = ledger.current();
    const rootCallId = activeRootCall(head).callId;
    const childHead = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: rootCallId,
      roleId: "reviewer",
      objective: "Review the current canonical evidence.",
    });
    const reviewerCallId = childHead.state.activeCallId;
    if (!reviewerCallId) throw new Error("reviewer call missing");
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: rootCallId,
      childCallId: reviewerCallId,
      outcome: "completed",
      summary: "The first audit completed.",
    });

    const input = buildInput(request, ledger);

    expect(input.contract.allowAuditor).toBe(true);
    expect(input.contract.availableAuditCriterionIds).toEqual([
      "request_completion",
    ]);
    expectOneCurrentRequest(input.messages);
  });

  test("keeps the group catalog closed, then projects only full descriptors from the selected scope", async () => {
    const { request, getDescriptors } = createRequest();
    const ledger = await createRootLedger();

    const closed = buildInput(request, ledger);

    expect(getDescriptors).toHaveBeenCalledOnce();
    expect(closed.capabilities).toEqual([]);
    expect(closed.capabilityCatalogGroups).toEqual([
      {
        groupId: FILE_GROUP,
        description: [
          "files.observe_primary: Observe the primary file.",
          "files.observe_secondary: Observe the secondary file.",
        ].join("\n"),
        memberCount: 2,
        effects: ["observation"],
      },
      {
        groupId: WEB_GROUP,
        description: "web.lookup: Look up one web resource.",
        memberCount: 1,
        effects: ["observation"],
      },
    ]);
    expect(
      parseRuntimeMessage(
        closed.messages,
        EXECUTION_CAPABILITY_GROUP_CATALOG_MESSAGE_KIND,
      ),
    ).toMatchObject({
      authority: "runtime_registry",
      presenceEffect: "passive_routing_metadata_not_user_intent",
      catalogGroups: closed.capabilityCatalogGroups,
    });
    expect(
      parseRuntimeMessage(
        closed.messages,
        EXECUTION_CAPABILITY_CATALOG_MESSAGE_KIND,
      ),
    ).toBeUndefined();
    expectOneCurrentRequest(closed.messages);

    const closedHead = ledger.current();
    const closedCall = activeRootCall(closedHead);
    await commit(ledger, {
      authority: "active_role",
      type: "update_capability_scope",
      callId: closedCall.callId,
      invocationAttempt: closedCall.activationCount,
      mode: "open",
      catalogGroupIds: [FILE_GROUP],
    });
    getDescriptors.mockClear();

    const scoped = buildInput(request, ledger);

    expect(getDescriptors).toHaveBeenCalledOnce();
    expect(scoped.capabilities).toEqual([observePrimary, observeSecondary]);
    expect(scoped.capabilities[0]).toMatchObject({
      controls: pathControls,
      selectionControlIds: ["path"],
      controlsRefinement: "mechanical_when_complete",
      catalogGroups: [FILE_GROUP],
    });
    expect(
      parseRuntimeMessage(
        scoped.messages,
        EXECUTION_CAPABILITY_CATALOG_MESSAGE_KIND,
      ),
    ).toEqual({
      kind: EXECUTION_CAPABILITY_CATALOG_MESSAGE_KIND,
      authority: "runtime_registry",
      capabilities: [
        {
          capabilityId: observePrimary.capabilityId,
          summary: observePrimary.summary,
          effect: observePrimary.effect,
          selectionControlIds: ["path"],
        },
        {
          capabilityId: observeSecondary.capabilityId,
          summary: observeSecondary.summary,
          effect: observeSecondary.effect,
          selectionControlIds: ["path"],
        },
      ],
    });
    expectOneCurrentRequest(scoped.messages);
  });

  test("keeps root selection controls authoritative when session paths are available", async () => {
    const runtimeBoundObservation: WorkerCapabilityDescriptor = Object.freeze({
      ...observePrimary,
      runtimePathControlIds: Object.freeze(["path"]),
    });
    const { request } = createRequest([runtimeBoundObservation], {
      sessionArtifactPaths: Object.freeze(["prior.txt"]),
    });
    const ledger = await createRootLedger([FILE_GROUP]);

    const input = buildInput(request, ledger);
    const schema = JSON.stringify(input.format.schema);

    expect(input.eligibleSessionArtifactPaths).toEqual(["prior.txt"]);
    expect(input.capabilities[0]?.selectionControlIds).toEqual(["path"]);
    expect(schema).toContain('"selectionControls"');
    expect(schema).toContain('"invoke_capability"');
    expect(schema).toContain('"invoke_capabilities"');
  });

  test.each([
    {
      label: "success",
      adapterResult: {
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "  Primary file observed exactly.\n",
        referenceData: "\texact-primary-data  ",
      },
    },
    {
      label: "failure",
      adapterResult: {
        outcome: "failed" as const,
        observedEffect: "none" as const,
        summary: "\nPrimary file was unavailable.  ",
        referenceData: "  exact-primary-failure\t",
        failureOutcomeFingerprint: `sha256:${"f".repeat(64)}`,
      },
    },
  ])(
    "projects one exact native tool lane for $label",
    async ({ adapterResult }) => {
      const adapter = createAdapter(observePrimary, adapterResult);
      const { request } = createRequest([observePrimary], {
        workerCapabilityProvider: {
          getDescriptors: () => Object.freeze([observePrimary]),
          getAdapters: () => Object.freeze([adapter]),
        },
      });
      const ledger = await createRootLedger([FILE_GROUP]);
      const head = ledger.current();
      const binding = createRoleCapabilityBinding({
        requestId: request.requestId,
        context: request,
        call: activeRootCall(head),
        ledger,
        adapters: [adapter],
      });
      const exactIntent = "Observe the exact primary file.";
      const exactControls = { path: "primary.txt" };

      await binding.execute({
        capabilityId: observePrimary.capabilityId,
        intent: exactIntent,
        controls: exactControls,
      });
      const input = buildInput(request, ledger);

      expect(() => validateModelGatewayMessages(input.messages)).not.toThrow();
      expect(
        input.capabilities.map(({ capabilityId }) => capabilityId),
      ).toEqual([observePrimary.capabilityId]);
      const requestIndex = expectOneCurrentRequest(input.messages);
      const actionIndex = input.messages.findIndex(
        (message) => message.role === "assistant" && "toolCalls" in message,
      );
      const resultIndex = input.messages.findIndex(
        (message) => message.role === "tool",
      );
      expect(requestIndex).toBeLessThan(actionIndex);
      expect(actionIndex).toBeLessThan(resultIndex);

      const actionMessage = input.messages[actionIndex];
      const resultMessage = input.messages[resultIndex];
      if (
        !actionMessage ||
        actionMessage.role !== "assistant" ||
        !("toolCalls" in actionMessage) ||
        !actionMessage.toolCalls ||
        !resultMessage ||
        resultMessage.role !== "tool"
      ) {
        throw new Error("expected one native tool interaction");
      }
      expect(actionMessage.toolCalls).toHaveLength(1);
      expect(actionMessage.toolCalls[0]).toMatchObject({
        callId: "capability-execution-1",
        name: EXECUTION_CAPABILITY_TOOL_NAME,
      });
      expect(JSON.parse(actionMessage.toolCalls[0]!.arguments)).toEqual({
        kind: EXECUTION_AGENT_ACTION_MESSAGE_KIND,
        authority: "accepted_execution_agent_action",
        invocationAttempt: 2,
        invocationIndex: 0,
        invocationCount: 1,
        action: "invoke_capability",
        invocation: {
          executionId: "capability-execution-1",
          capabilityId: observePrimary.capabilityId,
          controls: exactControls,
          declaredEffect: "observation",
        },
      });
      expect(actionMessage.toolCalls[0]!.arguments).not.toContain(exactIntent);
      expect(resultMessage).toMatchObject({
        toolCallId: "capability-execution-1",
        toolName: EXECUTION_CAPABILITY_TOOL_NAME,
      });
      const expectedAdapterEvidence =
        adapterResult.outcome === "failed"
          ? {
              outcome: adapterResult.outcome,
              observedEffect: adapterResult.observedEffect,
              summary: adapterResult.summary,
              referenceData: adapterResult.referenceData,
            }
          : adapterResult;
      expect(JSON.parse(resultMessage.content)).toEqual({
        kind: EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
        authority: "capability_adapter_result",
        presenceEffect: "runtime_result_only_not_user_intent",
        invocationAttempt: 2,
        result: {
          executionId: "capability-execution-1",
          capabilityId: observePrimary.capabilityId,
          adapterResult: {
            kind: "generic_capability_result_v1",
            authority: "capability_adapter",
            status: "executed",
            ok: adapterResult.outcome === "succeeded",
            payload: expectedAdapterEvidence,
          },
        },
      });
    },
  );

  test("projects one ordered batch action followed by exact success and failure results", async () => {
    const primaryResult = {
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Primary observed.",
      referenceData: "primary-data",
    };
    const secondaryEvidence = {
      outcome: "failed" as const,
      observedEffect: "indeterminate" as const,
      summary: "Secondary observation failed.",
      referenceData: "secondary-failure",
    };
    const secondaryResult = {
      ...secondaryEvidence,
      failureOutcomeFingerprint: `sha256:${"f".repeat(64)}`,
    };
    const adapters = [
      createAdapter(observePrimary, primaryResult),
      createAdapter(observeSecondary, secondaryResult),
    ] as const;
    const { request } = createRequest([observePrimary, observeSecondary], {
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([observePrimary, observeSecondary]),
        getAdapters: () => Object.freeze(adapters),
      },
    });
    const ledger = await createRootLedger([FILE_GROUP]);
    const head = ledger.current();
    const binding = createRoleCapabilityBinding({
      requestId: request.requestId,
      context: request,
      call: activeRootCall(head),
      ledger,
      adapters,
    });
    const invocations = [
      {
        capabilityId: observePrimary.capabilityId,
        intent: "Observe primary exactly.",
        controls: { path: "primary.txt" },
      },
      {
        capabilityId: observeSecondary.capabilityId,
        intent: "Observe secondary exactly.",
        controls: { path: "secondary.txt" },
      },
    ] as const;

    await binding.executeBatch({ invocations });
    const input = buildInput(request, ledger);

    expect(() => validateModelGatewayMessages(input.messages)).not.toThrow();
    const requestIndex = expectOneCurrentRequest(input.messages);
    const actionIndex = input.messages.findIndex(
      (message) => message.role === "assistant" && "toolCalls" in message,
    );
    expect(requestIndex).toBeLessThan(actionIndex);
    const actionMessage = input.messages[actionIndex];
    if (
      !actionMessage ||
      actionMessage.role !== "assistant" ||
      !("toolCalls" in actionMessage) ||
      !actionMessage.toolCalls
    ) {
      throw new Error("expected one native batch action");
    }
    expect(actionMessage.toolCalls).toHaveLength(2);
    expect(
      actionMessage.toolCalls.map((toolCall) => JSON.parse(toolCall.arguments)),
    ).toEqual(
      invocations.map((invocation, invocationIndex) => ({
        kind: EXECUTION_AGENT_ACTION_MESSAGE_KIND,
        authority: "accepted_execution_agent_action",
        invocationAttempt: 2,
        invocationIndex,
        invocationCount: 2,
        action: "invoke_capabilities",
        invocation: {
          executionId: `capability-execution-${invocationIndex + 1}`,
          capabilityId: invocation.capabilityId,
          controls: invocation.controls,
          declaredEffect: "observation",
        },
      })),
    );
    expect(JSON.stringify(actionMessage.toolCalls)).not.toContain(
      "Observe primary exactly.",
    );
    expect(JSON.stringify(actionMessage.toolCalls)).not.toContain(
      "Observe secondary exactly.",
    );
    const results = input.messages.filter(
      (message): message is Extract<ChatMessage, { role: "tool" }> =>
        message.role === "tool",
    );
    expect(results).toHaveLength(2);
    expect(results.map(({ content }) => JSON.parse(content))).toEqual([
      expect.objectContaining({
        invocationAttempt: 2,
        result: {
          executionId: "capability-execution-1",
          capabilityId: observePrimary.capabilityId,
          adapterResult: {
            kind: "generic_capability_result_v1",
            authority: "capability_adapter",
            status: "executed",
            ok: true,
            payload: primaryResult,
          },
        },
      }),
      expect.objectContaining({
        invocationAttempt: 2,
        result: {
          executionId: "capability-execution-2",
          capabilityId: observeSecondary.capabilityId,
          adapterResult: {
            kind: "generic_capability_result_v1",
            authority: "capability_adapter",
            status: "executed",
            ok: false,
            payload: secondaryEvidence,
          },
        },
      }),
    ]);
    expect(results.map(({ toolCallId }) => toolCallId)).toEqual([
      "capability-execution-1",
      "capability-execution-2",
    ]);
  });

  test("preserves an exact direct tool result beyond the legacy projection limit", async () => {
    const exactOutput = `  ${"x".repeat(120_000)}\n`;
    const ledger = await createRootLedger([FILE_GROUP]);
    let head = ledger.current();
    const call = activeRootCall(head);
    head = await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      capabilityId: observePrimary.capabilityId,
      declaredEffect: "observation",
      intent: "Observe the complete large result.",
      controlsJson: '{"path":"primary.txt"}',
    });
    const execution = head.state.capabilityExecutions[0];
    if (!execution) throw new Error("capability execution missing");
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: call.callId,
      executionId: execution.executionId,
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Large result captured canonically.",
      exactResult: {
        kind: "registered_tool_execution_result_v1",
        authority: "registered_plugin",
        status: "executed",
        result: {
          ok: true,
          tool: "read_file",
          output: exactOutput,
          producedNewInformation: true,
        },
      },
    });

    const continuation = buildExecutionContinuationMessages(
      ledger.current(),
      activeRootCall(ledger.current()),
    );
    const toolMessage = continuation.find(
      (message): message is Extract<ChatMessage, { role: "tool" }> =>
        message.role === "tool",
    );
    if (!toolMessage) throw new Error("exact tool continuation missing");
    const decoded = JSON.parse(toolMessage.content) as {
      result: { adapterResult: { result: { output: string } } };
    };

    expect(decoded.result.adapterResult.result.output).toBe(exactOutput);
    expect(decoded.result.adapterResult.result.output).toHaveLength(
      exactOutput.length,
    );
  });

  test("keeps exact prior-Worker intervention evidence and passive memory in their scoped Execution Agent inputs", async () => {
    const { request } = createRequest([]);
    const ledger = await createRootLedger(
      undefined,
      Object.freeze({
        id: "execution-agent-v1",
        version: 1,
        definitionHash: `sha256:${"f".repeat(64)}`,
        rootContractId: "execution_agent",
        availableSubordinateContractIds: Object.freeze(["worker"] as const),
        capabilityAuthorities: Object.freeze(["root", "worker"] as const),
      }),
    );
    const rootBeforeWorker = activeRootCall(ledger.current());
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: rootBeforeWorker.callId,
      roleId: "worker",
      objective: "Observe one exact bounded value.",
      workingDirectory: "project",
    });
    const worker = activeRootCall(ledger.current());
    const actionFingerprint = `sha256:${"f".repeat(64)}`;
    const exactReferenceData = "EXACT_PRIOR_WORKER_EVIDENCE";
    const exactControls = Object.freeze({ path: "primary.txt" });
    const originIntent = "Observe the exact bounded value.";
    const longTermMemoryMessage: ChatMessage = Object.freeze({
      role: "system" as const,
      content: JSON.stringify({
        kind: LONG_TERM_MEMORY_MESSAGE_KIND,
        authority: "passive_reference",
        purpose: "support_personalized_terminal_response_authoring",
        memories: [
          {
            content: "Prefer concise terminal responses.",
            tags: ["preference"],
          },
        ],
        presenceEffect:
          "reference_only_not_current_user_intent_assignment_action_authority_or_completion_evidence",
      }),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const activeWorker = activeRootCall(ledger.current());
      const begun = await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: activeWorker.callId,
        invocationAttempt: activeWorker.activationCount,
        capabilityId: observePrimary.capabilityId,
        declaredEffect: "observation",
        intent: originIntent,
        controlsJson: JSON.stringify(exactControls),
        actionFingerprint,
      });
      const execution = begun.state.capabilityExecutions.at(-1);
      if (!execution) throw new Error("Worker execution missing");
      await commit(ledger, {
        authority: "runtime",
        type: "settle_capability_execution",
        callId: activeWorker.callId,
        executionId: execution.executionId,
        outcome: "succeeded",
        outcomeFingerprint: "succeeded",
        observedEffect: "observation",
        summary: "Observed the exact prior Worker value.",
        referenceData: exactReferenceData,
        exactResult: {
          kind: "generic_capability_result_v1",
          authority: "capability_adapter",
          status: "executed",
          ok: true,
          payload: {
            marker: exactReferenceData,
            attempt,
          },
        },
      });
    }
    const warnedWorker = activeRootCall(ledger.current());
    expect(warnedWorker.callId).toBe(worker.callId);
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: rootBeforeWorker.callId,
      childCallId: warnedWorker.callId,
      outcome: "completed",
      summary: "The Worker established the exact bounded value.",
    });

    const rootBeforeIntervention = activeRootCall(ledger.current());
    const executionCountBeforeIntervention =
      ledger.current().state.capabilityExecutions.length;
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: rootBeforeIntervention.callId,
      invocationAttempt: rootBeforeIntervention.activationCount,
      capabilityId: observePrimary.capabilityId,
      declaredEffect: "observation",
      intent: "Repeat the exact bounded observation.",
      controlsJson: JSON.stringify(exactControls),
      actionFingerprint,
    });

    const head = ledger.current();
    const root = activeRootCall(head);
    expect(head.state.capabilityExecutions).toHaveLength(
      executionCountBeforeIntervention,
    );
    expect(buildExecutionContinuationMessages(head, root)).toEqual([]);
    const steeringSnapshot = createRequestSteeringInbox({
      requestId: request.requestId,
    }).snapshot();
    const decisionInput = buildExecutionAgentInput(request, {
      head,
      call: root,
      steeringSnapshot,
      includeAcknowledgement: false,
      includeTitle: false,
      allowPlanner: true,
      allowAuditor: true,
    });
    const responseInput = buildExecutionAgentResponseInput(request, {
      head,
      call: root,
      steeringSnapshot,
      longTermMemoryMessage,
    });

    expect(
      parseRuntimeMessage(decisionInput.messages, "runtime_execution_state_v1"),
    ).toMatchObject({
      operationSupervision: [
        {
          stage: "intervention",
          originExecutionId: "capability-execution-2",
        },
      ],
    });
    for (const messages of [decisionInput.messages, responseInput.messages]) {
      const supervisionEvidence = parseRuntimeMessage(
        messages,
        OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
      );
      if (!supervisionEvidence) {
        throw new Error("operation supervision evidence missing");
      }
      expect(supervisionEvidence).toMatchObject({
        kind: OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
        sourceRevision: head.revision,
        binding: {
          callId: root.callId,
          invocationAttempt: root.activationCount,
          consumers: ["activation_decision", "immediate_presentation_handoff"],
        },
        entries: [
          {
            originExecutionId: "capability-execution-2",
            notice: {
              stage: "intervention",
              originExecutionId: "capability-execution-2",
            },
            evidence: {
              kind: "embedded_cross_call_exact_result",
              acceptedAction: {
                executionId: "capability-execution-2",
                capabilityId: observePrimary.capabilityId,
                controls: exactControls,
                declaredEffect: "observation",
                workingDirectory: "project",
              },
              receipt: {
                executionId: "capability-execution-2",
                callId: warnedWorker.callId,
                referenceData: exactReferenceData,
              },
              adapterResult: {
                kind: "generic_capability_result_v1",
                payload: {
                  marker: exactReferenceData,
                  attempt: 1,
                },
              },
            },
          },
        ],
      });
      expect(JSON.stringify(supervisionEvidence)).not.toContain('"intent":');
      expect(JSON.stringify(supervisionEvidence)).not.toContain(originIntent);
    }
    expect(
      parseRuntimeMessage(responseInput.messages, "runtime_execution_state_v1"),
    ).not.toHaveProperty("operationSupervision");
    expect(
      parseRuntimeMessage(
        decisionInput.messages,
        LONG_TERM_MEMORY_MESSAGE_KIND,
      ),
    ).toBeUndefined();
    expect(
      parseRuntimeMessage(
        responseInput.messages,
        LONG_TERM_MEMORY_MESSAGE_KIND,
      ),
    ).toMatchObject({
      authority: "passive_reference",
      memories: [{ content: "Prefer concise terminal responses." }],
    });
    const supervisionMessageIndex = responseInput.messages.findIndex(
      (message) =>
        message.role !== "tool" &&
        message.content.includes(
          `"kind":"${OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND}"`,
        ),
    );
    const memoryMessageIndex = responseInput.messages.findIndex(
      (message) =>
        message.role !== "tool" &&
        message.content.includes(`"kind":"${LONG_TERM_MEMORY_MESSAGE_KIND}"`),
    );
    expect(supervisionMessageIndex).toBeGreaterThan(-1);
    expect(memoryMessageIndex).toBe(supervisionMessageIndex + 1);
  });

  test("defers an explicitly over-budget pinned execution context to model-step compaction", async () => {
    const { request } = createRequest(descriptors, {
      runnerConfig: {
        ...runnerConfig,
        context: {
          outputReserveTokens: 0,
          safetyReserveTokens: 0,
          attachmentReserveTokens: 0,
        },
      },
      modelPolicy: {
        ...modelPolicy,
        profiles: {
          "execution-agent-context-test": {
            ...modelPolicy.profiles["execution-agent-context-test"],
            contextWindowTokens: 64,
          },
        },
      },
    });
    const ledger = await createRootLedger();
    const input = buildInput(request, ledger);

    expect(input.context.budget.estimatedInputTokens).toBeGreaterThan(
      input.context.budget.availableInputTokens,
    );
    expect(input.context.compaction).toEqual({
      applied: false,
      compactedSourceRefs: [],
    });
  });
});
