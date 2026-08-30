import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ModelGatewayClient } from "../ports.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import {
  buildCompactedRequestToolResultsMessage,
  buildRequestToolResultsMessage,
  projectRequestToolResults,
  type RequestToolResultsView,
} from "../context/request-tool-results.js";
import { OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND } from "../context/operation-supervision-evidence.js";
import {
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  assertValidSemanticCompactionCheckpoint,
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/index.js";
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
import {
  createWorkerCapabilityBinding,
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
  projectWorkerSettledCapabilityResults,
  WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { projectWorkerCapabilitySelectionCatalog } from "../steps/worker-decision/capability-catalog.js";
import {
  buildWorkerDecisionInput,
  CAPABILITY_CONTROLS_MODEL_STEP,
  createWorkerDecisionFormat,
  parseWorkerDecisionOutput,
  projectWorkerCapabilityResumeContext,
  runWorkerDecision,
  WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH,
  WORKER_CAPABILITY_INTENT_MAX_LENGTH,
  WORKER_DECISION_MODEL_STEP,
  WORKER_RESULT_MODEL_STEP,
} from "../steps/worker-decision/index.js";

type TestContext = Readonly<{ marker: string }>;

const EMPTY_REQUEST_TOOL_RESULTS: RequestToolResultsView = Object.freeze({
  sourceRevision: 0,
  results: Object.freeze([]),
});

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
        "capability.controls": {},
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

function createRequest(
  invoke: ModelGatewayClient["invoke"] = vi.fn(async () => ({
    text: workerDecisionText({
      action: "invoke_capability",
      capabilityId: "example.observe",
      intent: "Read the exact current value.",
      controls: {},
    }),
    meta: {},
  })),
  options: Readonly<{ contextWindowTokens?: number }> = {},
): RequestExecutionScope {
  return createTestRequestExecutionScope({
    requestId: "worker-capability-request",
    sessionId: "worker-capability-session",
    prompt: "ORIGINAL_USER_PROMPT_MUST_NOT_REACH_WORKER",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig,
    attachments: [],
    agentMode: "reasoning",
    modelPolicy: options.contextWindowTokens
      ? {
          ...modelPolicy,
          profiles: {
            ...modelPolicy.profiles,
            "runtime-default": {
              ...modelPolicy.profiles["runtime-default"],
              contextWindowTokens: options.contextWindowTokens,
            },
          },
        }
      : modelPolicy,
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

async function openWorkerLedger(
  workerCapabilityCatalogGroupIds?: readonly string[],
  workingDirectory?: string,
): Promise<Readonly<{ ledger: RoleCallLedger; call: RoleCallFrame }>> {
  const ledger = createRoleCallLedger({
    requestId: "worker-capability-request",
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
  await commit(ledger, { authority: "runtime", type: "create_root" });
  const opened = await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Return the exact current value supplied by observation.",
    ...(workerCapabilityCatalogGroupIds
      ? {
          workerCapabilityScope: {
            catalogGroupIds: workerCapabilityCatalogGroupIds,
          },
        }
      : {}),
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
  });
  const call = opened.state.calls.find(
    (candidate) => candidate.callId === opened.state.activeCallId,
  );
  if (!call) throw new Error("active Worker call missing");
  return Object.freeze({ ledger, call });
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command: withTestCapabilityInvocation(command),
  });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}

function withTestCapabilityInvocation(command: unknown): unknown {
  if (
    typeof command !== "object" ||
    command === null ||
    Array.isArray(command)
  ) {
    return command;
  }
  const record = command as Record<string, unknown>;
  if (record.type === "begin_capability_execution") {
    return {
      ...record,
      intent: record.intent ?? "Exercise the exact test capability.",
      controlsJson: record.controlsJson ?? "{}",
    };
  }
  if (record.type === "settle_capability_execution") {
    return {
      ...record,
      exactResult: record.exactResult ?? {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: record.outcome === "succeeded",
        payload: {
          outcome: record.outcome,
          observedEffect: record.observedEffect,
          summary: record.summary,
          ...(typeof record.referenceData === "string"
            ? { referenceData: record.referenceData }
            : {}),
        },
        ...(Array.isArray(record.references)
          ? { references: record.references }
          : {}),
      },
    };
  }
  return command;
}

function observationAdapter(
  summary = "Observe one exact current value.",
): WorkerCapabilityAdapter<TestContext> {
  return {
    descriptor: {
      capabilityId: "example.observe",
      summary,
      effect: "observation",
      controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
    },
    execute: vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Observed value: cobalt.",
    })),
  };
}

function collectNamedPropertySchemas(
  value: unknown,
  propertyId: string,
): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      collectNamedPropertySchemas(entry, propertyId),
    );
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
      collectNamedPropertySchemas(entry, propertyId),
    ),
  ];
}

function createBinding(
  ledger: RoleCallLedger,
  call: RoleCallFrame,
  adapter = observationAdapter(),
) {
  return createWorkerCapabilityBinding({
    requestId: "worker-capability-request",
    context: Object.freeze({ marker: "context-1" }),
    call,
    ledger,
    adapters: [adapter],
  });
}

function capabilitySource(
  ledger: RoleCallLedger,
  binding: ReturnType<typeof createBinding>,
  head = ledger.current(),
) {
  return Object.freeze({ binding, ledger, head });
}

function requireActiveWorkerCall(ledger: RoleCallLedger): RoleCallFrame {
  const head = ledger.current();
  const call = head.state.calls.find(
    ({ callId }) => callId === head.state.activeCallId,
  );
  if (!call || call.roleId !== "worker") {
    throw new Error("active Worker call missing");
  }
  return call;
}

function requestToolResults(
  ledger: RoleCallLedger,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): RequestToolResultsView {
  return projectRequestToolResults({
    ledger,
    head,
    modelStep: WORKER_DECISION_MODEL_STEP,
    callId: call.callId,
  });
}

async function settleWorkerObservationEvidence(
  ledger: RoleCallLedger,
  call: RoleCallFrame,
  summary: string,
): Promise<
  Readonly<{
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
    requestToolResults: RequestToolResultsView;
  }>
> {
  await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "example.prior",
    declaredEffect: "observation",
  });
  const head = await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: "capability-execution-1",
    outcome: "succeeded",
    observedEffect: "observation",
    summary,
  });
  const resumedCall = head.state.calls.find(
    (candidate) => candidate.callId === call.callId,
  );
  if (!resumedCall) throw new Error("resumed Worker call missing");

  return Object.freeze({
    head,
    call: resumedCall,
    requestToolResults: requestToolResults(ledger, head, resumedCall),
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

describe("generic Worker capability decision boundary", () => {
  test("projects stored paths only in the exact phase that authors a runtime path control", async () => {
    const { ledger, call } = await openWorkerLedger(undefined, "news");
    const adapter: WorkerCapabilityAdapter<TestContext> = {
      descriptor: {
        capabilityId: "inspect_target",
        summary: "Inspect one existing target.",
        effect: "observation",
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4_096 },
          },
          required: ["path"],
        },
        runtimePathControlIds: ["path"],
      },
      execute: vi.fn(async () => ({
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "Inspected the target.",
      })),
    };
    const binding = createBinding(ledger, call, adapter);
    const request = Object.freeze({
      ...createRequest(),
      sessionArtifactPaths: Object.freeze(["news/news.txt"]),
    });
    const selectionInput = buildWorkerDecisionInput(request, {
      call,
      requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      capabilitySource: capabilitySource(ledger, binding),
    });

    expect(
      hasRuntimeMessageKind(
        selectionInput.context.messages,
        "runtime_session_artifact_paths_v1",
      ),
    ).toBe(false);

    const executionInput = buildWorkerDecisionInput(request, {
      call,
      requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      capabilitySource: capabilitySource(ledger, binding),
      selectedCapabilityExecution: {
        capabilityId: "inspect_target",
        intent: "Inspect the stored news artifact.",
        guidance: "",
      },
    });
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
        "runtime_session_artifact_paths_v1",
      ),
    ).toMatchObject({
      authority: "canonical_runtime_state",
      targets: ["news/news.txt"],
      nonAuthority: {
        addsUserIntent: false,
        choosesOrRedirectsTarget: false,
        provesTargetExists: false,
      },
    });
  });

  test("bounds the client intent identically for single and batch selection", () => {
    expect(WORKER_CAPABILITY_INTENT_MAX_LENGTH).toBe(500);
    const primaryObservation = observationAdapter().descriptor;
    const secondaryObservation = {
      ...primaryObservation,
      capabilityId: "example.observe.secondary",
    } satisfies WorkerCapabilityDescriptor;
    const format = createWorkerDecisionFormat({
      capabilities: [primaryObservation, secondaryObservation],
      maxBatchCapabilityExecutions: 4,
    });
    const variants = (
      format.schema as {
        properties: {
          decision: {
            anyOf: Array<{
              properties: Record<string, unknown>;
            }>;
          };
        };
      }
    ).properties.decision.anyOf;
    const singleIntent = variants[2]!.properties.intent as {
      description: string;
      minLength: number;
      maxLength: number;
    };
    const batchIntent = (
      variants[3]!.properties.invocations as {
        items: {
          properties: {
            intent: {
              description: string;
              minLength: number;
              maxLength: number;
            };
          };
        };
      }
    ).items.properties.intent;

    for (const intentSchema of [singleIntent, batchIntent]) {
      expect(intentSchema).toMatchObject({
        minLength: 1,
        maxLength: 500,
      });
    }
    expect(batchIntent.description).toBe(singleIntent.description);
  });

  test("separates payload authoring assignments for identical single and batch selection schemas", () => {
    const sharedControls = {
      type: "object" as const,
      additionalProperties: false as const,
      properties: {
        source: {
          type: "string" as const,
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ["source"],
    };
    const plainObservation = {
      capabilityId: "example.observe.plain",
      summary: "Observe one plain source.",
      effect: "observation" as const,
      controls: sharedControls,
      selectionControlIds: ["source"],
    } satisfies WorkerCapabilityDescriptor;
    const payloadObservation = {
      ...plainObservation,
      capabilityId: "example.observe.payload",
      summary: "Observe one source through an authored payload.",
      requiresPayloadAuthoringObjective: true,
    } satisfies WorkerCapabilityDescriptor;
    const format = createWorkerDecisionFormat({
      capabilities: [plainObservation, payloadObservation],
      maxBatchCapabilityExecutions: 2,
    });
    type CapabilityVariant = Readonly<{
      properties: Readonly<{
        capabilityId?: Readonly<{ enum?: readonly string[] }>;
        authoringObjective?: unknown;
        invocations?: Readonly<{
          items?: Readonly<{ anyOf?: readonly CapabilityVariant[] }>;
        }>;
      }>;
      required?: readonly string[];
    }>;
    const decisionVariants = (
      format.schema as {
        properties: { decision: { anyOf: readonly CapabilityVariant[] } };
      }
    ).properties.decision.anyOf;
    const variantFor = (
      variants: readonly CapabilityVariant[],
      capabilityId: string,
    ) =>
      variants.find((variant) =>
        variant.properties.capabilityId?.enum?.includes(capabilityId),
      );
    const plainSingle = variantFor(
      decisionVariants,
      plainObservation.capabilityId,
    );
    const payloadSingle = variantFor(
      decisionVariants,
      payloadObservation.capabilityId,
    );
    const batchItems = decisionVariants.find(
      (variant) => variant.properties.invocations,
    )?.properties.invocations?.items?.anyOf;

    expect(plainSingle?.properties).not.toHaveProperty("authoringObjective");
    expect(plainSingle?.required).not.toContain("authoringObjective");
    expect(payloadSingle?.properties).toHaveProperty("authoringObjective");
    expect(payloadSingle?.required).toContain("authoringObjective");
    expect(batchItems).toHaveLength(2);
    expect(
      variantFor(batchItems ?? [], plainObservation.capabilityId)?.properties,
    ).not.toHaveProperty("authoringObjective");
    const payloadBatch = variantFor(
      batchItems ?? [],
      payloadObservation.capabilityId,
    );
    expect(payloadBatch?.properties).toHaveProperty("authoringObjective");
    expect(payloadBatch?.required).toContain("authoringObjective");
  });

  test("projects an unbounded remaining control without weakening its bounded sibling", () => {
    const descriptor: WorkerCapabilityDescriptor = Object.freeze({
      capabilityId: "example.execute",
      summary: "Execute one exact command.",
      effect: "mixed",
      controls: Object.freeze({
        type: "object" as const,
        additionalProperties: false as const,
        properties: Object.freeze({
          command: Object.freeze({ type: "string" as const, minLength: 1 }),
          cwd: Object.freeze({
            type: "string" as const,
            minLength: 1,
            maxLength: 4_096,
          }),
        }),
        required: Object.freeze(["command", "cwd"]),
      }),
    });
    const format = createWorkerDecisionFormat({
      capabilities: [descriptor],
      pendingCapabilitySelection: {
        capabilityId: descriptor.capabilityId,
        intent: "Execute the requested command.",
      },
    });

    const commandSchemas = collectNamedPropertySchemas(
      format.schema,
      "command",
    );
    expect(commandSchemas.length).toBeGreaterThan(0);
    expect(commandSchemas).toEqual(
      commandSchemas.map(() => ({ type: "string", minLength: 1 })),
    );
    const cwdSchemas = collectNamedPropertySchemas(format.schema, "cwd");
    expect(cwdSchemas.length).toBeGreaterThan(0);
    expect(cwdSchemas).toEqual(
      cwdSchemas.map(() => ({
        type: "string",
        minLength: 1,
        maxLength: 4_096,
      })),
    );

    expect(format.postValidatedSchemaConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "maxLength",
          path: expect.stringContaining("/properties/cwd/maxLength"),
        }),
      ]),
    );
    expect(
      format.postValidatedSchemaConstraints?.some(({ path }) =>
        path.includes("/properties/command/maxLength"),
      ),
    ).toBe(false);
  });

  test("projects a deterministic compact multi-group capability catalog", () => {
    const capabilities = [
      {
        capabilityId: "write.one",
        summary: "Write one exact value. ".repeat(8),
        effect: "mutation",
        controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
        catalogGroups: Object.freeze(["w", "s"]),
      },
      {
        capabilityId: "read.two",
        summary: "Read a second exact value. ".repeat(8),
        effect: "observation",
        controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
        catalogGroups: Object.freeze(["r"]),
      },
      {
        capabilityId: "read.one",
        summary: "Read one exact value. ".repeat(8),
        effect: "observation",
        controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
        catalogGroups: Object.freeze(["s", "r"]),
      },
      {
        capabilityId: "memory.one",
        summary: "Read one remembered exact value. ".repeat(8),
        effect: "observation",
        controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
        catalogGroups: Object.freeze(["m"]),
      },
    ] satisfies readonly WorkerCapabilityDescriptor[];

    const projection = projectWorkerCapabilitySelectionCatalog(capabilities);

    expect(projection).toMatchObject({
      kind: "grouped",
      groupCount: 4,
      membershipCount: 6,
      promptPayload: {
        availableCapabilityCatalog: {
          columns: ["capabilityId", "summary", "effect", "catalogGroups"],
          entries: [
            [
              "memory.one",
              "Read one remembered exact value. ".repeat(8),
              "observation",
              ["m"],
            ],
            [
              "read.one",
              "Read one exact value. ".repeat(8),
              "observation",
              ["r", "s"],
            ],
            [
              "read.two",
              "Read a second exact value. ".repeat(8),
              "observation",
              ["r"],
            ],
            [
              "write.one",
              "Write one exact value. ".repeat(8),
              "mutation",
              ["s", "w"],
            ],
          ],
        },
      },
    });
    expect(projection.groupedCharacterCount).toBeLessThan(
      projection.flatCharacterCount,
    );
  });

  test("falls back to flat affordances when grouping is not smaller", () => {
    const capability = {
      capabilityId: "read.one",
      summary: "Read.",
      effect: "observation",
      controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
      catalogGroups: Object.freeze(["long-special-purpose-group"]),
    } satisfies WorkerCapabilityDescriptor;

    const projection = projectWorkerCapabilitySelectionCatalog([capability]);

    expect(projection.kind).toBe("flat");
    expect(projection.promptPayload).toEqual({
      availableCapabilities: [
        {
          capabilityId: "read.one",
          summary: "Read.",
          effect: "observation",
        },
      ],
    });
  });

  test("selects one offered capability without exposing its controls contract", () => {
    const offeredCapability = observationAdapter().descriptor;
    const format = createWorkerDecisionFormat({
      capabilities: [offeredCapability],
    });
    expect(format).toMatchObject({
      postValidatedSchemaConstraints: [
        {},
        {
          keyword: "maxLength",
          path: "/properties/decision/anyOf/2/properties/intent/maxLength",
        },
      ],
      schema: {
        type: "object",
        properties: {
          decision: {
            anyOf: [
              {},
              {},
              {
                properties: {
                  action: { enum: ["invoke_capability"] },
                  capabilityId: { enum: ["example.observe"] },
                  intent: {
                    minLength: 1,
                    maxLength: WORKER_CAPABILITY_INTENT_MAX_LENGTH,
                  },
                },
                required: ["action", "capabilityId", "intent"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["decision"],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(format.schema)).not.toContain("declaredEffect");
    expect(JSON.stringify(format.schema)).not.toContain('"authoringObjective"');
    expect(() =>
      createWorkerDecisionFormat({
        capabilities: [offeredCapability, offeredCapability],
      }),
    ).toThrow("worker_capabilities_invalid");

    const accepted = parseWorkerDecisionOutput(
      workerDecisionText({
        action: "invoke_capability",
        capabilityId: "example.observe",
        intent: "  Read the current value.  ",
      }),
      undefined,
      { availableCapabilities: [offeredCapability] },
    );
    expect(accepted).toEqual({
      ok: true,
      decision: {
        action: "invoke_capability",
        capabilityId: "example.observe",
        intent: "Read the current value.",
      },
    });
    if (accepted.ok) {
      expect(Object.isFrozen(accepted.decision)).toBe(true);
    }

    for (const [output, issueCode, path] of [
      [
        {
          action: "invoke_capability",
          capabilityId: "missing.observe",
          intent: "Read.",
        },
        "worker_capability_unavailable",
        "decision.capabilityId",
      ],
      [
        {
          action: "invoke_capability",
          capabilityId: "example.observe",
          intent: " ",
        },
        "worker_capability_intent_invalid",
        "decision.intent",
      ],
      [
        {
          action: "invoke_capability",
          capabilityId: "example.observe",
          intent: "x".repeat(WORKER_CAPABILITY_INTENT_MAX_LENGTH + 1),
        },
        "worker_capability_intent_invalid",
        "decision.intent",
      ],
      [
        {
          action: "invoke_capability",
          capabilityId: "example.observe",
          intent: "Read.",
          authoringObjective: "Author payload content.",
        },
        "worker_decision_shape_invalid",
        "decision",
      ],
      [
        {
          action: "invoke_capability",
          capabilityId: "example.observe",
          intent: "Read.",
          controls: { query: "hidden" },
        },
        "worker_decision_shape_invalid",
        "decision",
      ],
      [
        {
          action: "invoke_capability",
          capabilityId: "example.observe",
          intent: "Read.",
          declaredEffect: "mutation",
        },
        "worker_decision_shape_invalid",
        "decision",
      ],
    ] as const) {
      expect(
        parseWorkerDecisionOutput(workerDecisionText(output), undefined, {
          availableCapabilities: [offeredCapability],
        }),
      ).toMatchObject({
        ok: false,
        stage: "domain_parser",
        issues: [expect.objectContaining({ code: issueCode, path })],
      });
    }
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capability",
          capabilityId: "example.observe",
          intent: "Read.",
        }),
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          code: "worker_capability_unavailable",
          path: "decision.capabilityId",
        },
      ],
    });
  });

  test("keeps a large selection catalog bounded and defers every tool schema", () => {
    const capabilities = Array.from({ length: 40 }, (_, index) => ({
      ...observationAdapter().descriptor,
      capabilityId: `example.tool_${index}`,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          deferred_query: {
            type: "string" as const,
            minLength: 1,
            maxLength: 4_096,
          },
          deferred_path: {
            type: "string" as const,
            minLength: 1,
            maxLength: 4_096,
          },
        },
        required: ["deferred_query", "deferred_path"],
      },
    }));
    const selection = createWorkerDecisionFormat({
      capabilities,
      maxBatchCapabilityExecutions: 32,
    });
    const selectionSchema = JSON.stringify(selection.schema);

    expect(selectionSchema.length).toBeLessThan(3_000);
    expect(selectionSchema).not.toContain('"controls"');
    expect(selectionSchema).not.toContain("deferred_query");
    expect(selectionSchema).not.toContain("deferred_path");
    expect(
      (selection.schema as { properties: { decision: { anyOf: unknown[] } } })
        .properties.decision.anyOf,
    ).toHaveLength(4);

    const selected = capabilities[17]!;
    const execution = createWorkerDecisionFormat({
      capabilities: [selected],
      pendingCapabilitySelection: {
        capabilityId: selected.capabilityId,
        intent: "Inspect one target.",
      },
    });
    const executionSchema = JSON.stringify(execution.schema);
    expect(executionSchema).toContain('"controls"');
    expect(executionSchema).toContain("deferred_query");
    expect(executionSchema).toContain("deferred_path");
  });

  test("defers repeated observation batch identity until full materialization", () => {
    const observation = {
      ...observationAdapter().descriptor,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          source: {
            type: "string" as const,
            minLength: 1,
            maxLength: 64,
          },
        },
        required: ["source"],
      },
    };
    const mutation = {
      ...observationAdapter().descriptor,
      capabilityId: "example.write",
      effect: "mutation" as const,
    };
    const secondObservation = {
      ...observation,
      capabilityId: "example.observe.secondary",
    };
    const format = createWorkerDecisionFormat({
      capabilities: [observation, secondObservation, mutation],
      maxBatchCapabilityExecutions: 4,
    });
    expect(format.schema).toMatchObject({
      type: "object",
      properties: {
        decision: {
          anyOf: [
            {},
            {},
            {
              properties: {
                action: { enum: ["invoke_capability"] },
                capabilityId: {
                  enum: [
                    "example.observe",
                    "example.observe.secondary",
                    "example.write",
                  ],
                },
              },
            },
            {
              properties: {
                action: { enum: ["invoke_capabilities"] },
                invocations: {
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    properties: {
                      capabilityId: {
                        enum: ["example.observe", "example.observe.secondary"],
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      required: ["decision"],
      additionalProperties: false,
    });
    expect(format.postValidatedSchemaConstraints).toContainEqual({
      keyword: "maxLength",
      path: "/properties/decision/anyOf/3/properties/invocations/items/properties/intent/maxLength",
    });
    expect(JSON.stringify(format.schema)).not.toContain('"controls"');

    const parameterlessObservationFormat = createWorkerDecisionFormat({
      capabilities: [observation],
      maxBatchCapabilityExecutions: 4,
    });
    expect(JSON.stringify(parameterlessObservationFormat.schema)).toContain(
      '"invoke_capabilities"',
    );

    const accepted = parseWorkerDecisionOutput(
      workerDecisionText({
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: "example.observe",
            intent: "Read source A.",
          },
          {
            capabilityId: "example.observe.secondary",
            intent: "Read source B.",
          },
        ],
      }),
      undefined,
      {
        availableCapabilities: [observation, secondObservation, mutation],
        maxBatchCapabilityExecutions: 4,
      },
    );
    expect(accepted).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: "example.observe",
            intent: "Read source A.",
          },
          {
            capabilityId: "example.observe.secondary",
            intent: "Read source B.",
          },
        ],
      },
    });
    if (accepted.ok && accepted.decision.action === "invoke_capabilities") {
      expect(Object.isFrozen(accepted.decision.invocations)).toBe(true);
      expect(accepted.decision.invocations.every(Object.isFrozen)).toBe(true);
    }

    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "example.observe",
              intent: "Read source A.",
            },
            {
              capabilityId: "example.observe",
              intent: "Read source B.",
            },
          ],
        }),
        undefined,
        {
          availableCapabilities: [observation],
          maxBatchCapabilityExecutions: 4,
        },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: "example.observe",
            intent: "Read source A.",
          },
          {
            capabilityId: "example.observe",
            intent: "Read source B.",
          },
        ],
      },
    });

    const boundObservation = {
      ...observation,
      selectionControlIds: ["source"],
    } as const satisfies WorkerCapabilityDescriptor;
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "example.observe",
              intent: "Read source A first.",
              selectionControls: { source: "A" },
            },
            {
              capabilityId: "example.observe",
              intent: "Read source A again.",
              selectionControls: { source: "A" },
            },
          ],
        }),
        undefined,
        {
          availableCapabilities: [boundObservation],
          maxBatchCapabilityExecutions: 4,
        },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: "example.observe",
            intent: "Read source A first.",
            selectionControls: { source: "A" },
          },
          {
            capabilityId: "example.observe",
            intent: "Read source A again.",
            selectionControls: { source: "A" },
          },
        ],
      },
    });

    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "example.observe",
              intent: "Read source A.",
            },
            {
              capabilityId: "example.write",
              intent: "Write source B.",
            },
          ],
        }),
        undefined,
        {
          availableCapabilities: [observation, mutation],
          maxBatchCapabilityExecutions: 4,
        },
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "worker_capability_batch_effect_invalid",
          path: "decision.invocations[1].capabilityId",
        }),
      ],
    });
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "example.observe",
              intent: "Read source A.",
            },
          ],
        }),
        undefined,
        {
          availableCapabilities: [observation],
          maxBatchCapabilityExecutions: 4,
        },
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "worker_capability_batch_size_invalid",
          path: "decision.invocations",
        }),
      ],
    });
  });

  test("keeps frozen batch selections out of the no-evidence controls schema", () => {
    const observation = {
      ...observationAdapter().descriptor,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          source: {
            type: "string" as const,
            minLength: 1,
            maxLength: 64,
          },
          query: {
            type: "string" as const,
            minLength: 1,
            maxLength: 64,
          },
        },
        required: ["source", "query"],
      },
      selectionControlIds: ["source"],
    } satisfies WorkerCapabilityDescriptor;
    const intents = ['Read source "A".', 'Read source "B".'] as const;
    const format = createWorkerDecisionFormat({
      capabilities: [observation],
      maxBatchCapabilityExecutions: 2,
      allowSingleCapabilityInvocation: false,
      allowReturnResult: false,
      pendingCapabilityBatchSelection: intents.map((intent, index) => ({
        capabilityId: observation.capabilityId,
        intent,
        selectionControls: { source: index === 0 ? "A" : "B" },
      })),
    });

    expect(format.schema).toMatchObject({
      properties: {
        decision: {
          anyOf: [
            {},
            {
              properties: {
                invocations: {
                  type: "object",
                  properties: {
                    invocation_1: {
                      description: expect.stringContaining(
                        observation.capabilityId,
                      ),
                      properties: {
                        controls: {
                          properties: {
                            query: {
                              type: "string",
                              minLength: 1,
                              maxLength: 64,
                            },
                          },
                        },
                      },
                    },
                    invocation_2: {
                      description: expect.stringContaining(
                        observation.capabilityId,
                      ),
                      properties: {
                        controls: {
                          properties: {
                            query: {
                              type: "string",
                              minLength: 1,
                              maxLength: 64,
                            },
                          },
                        },
                      },
                    },
                  },
                  required: ["invocation_1", "invocation_2"],
                  additionalProperties: false,
                },
              },
            },
          ],
        },
      },
    });
    const serializedSchema = JSON.stringify(format.schema);
    expect(serializedSchema).not.toContain("return_result");
    intents.forEach((intent) => {
      expect(serializedSchema).not.toContain(JSON.stringify(intent));
    });
    expect(serializedSchema).not.toContain('"capabilityId"');
    expect(serializedSchema).not.toContain('"intent"');
    expect(format.postValidatedSchemaConstraints).toContainEqual({
      keyword: "maxLength",
      path: "/properties/decision/anyOf/1/properties/invocations/properties/invocation_1/properties/controls/properties/query/maxLength",
    });
    expect(format.postValidatedSchemaConstraints).toContainEqual({
      keyword: "maxLength",
      path: "/properties/decision/anyOf/1/properties/invocations/properties/invocation_2/properties/controls/properties/query/maxLength",
    });
  });

  test("restores each frozen payload authoring objective to its exact batch slot after refinement", () => {
    const observation = {
      capabilityId: "example.observe.payload",
      summary: "Observe one source through an authored payload.",
      effect: "observation" as const,
      requiresPayloadAuthoringObjective: true,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          source: {
            type: "string" as const,
            minLength: 1,
            maxLength: 64,
          },
          query: {
            type: "string" as const,
            minLength: 1,
            maxLength: 64,
          },
        },
        required: ["source", "query"],
      },
      selectionControlIds: ["source"],
    } satisfies WorkerCapabilityDescriptor;
    const pendingCapabilityBatchSelection = [
      {
        capabilityId: observation.capabilityId,
        intent: "Read source A.",
        authoringObjective: "Author the exact query for source A.",
        selectionControls: { source: "A" },
      },
      {
        capabilityId: observation.capabilityId,
        intent: "Read source B.",
        authoringObjective: "Author the exact query for source B.",
        selectionControls: { source: "B" },
      },
    ] as const;
    const format = createWorkerDecisionFormat({
      capabilities: [observation],
      maxBatchCapabilityExecutions: 2,
      allowSingleCapabilityInvocation: false,
      allowReturnResult: false,
      pendingCapabilityBatchSelection,
    });

    expect(JSON.stringify(format.schema)).not.toContain("authoringObjective");
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capabilities",
          invocations: {
            invocation_1: { controls: { query: "query A" } },
            invocation_2: { controls: { query: "query B" } },
          },
        }),
        undefined,
        {
          availableCapabilities: [observation],
          decisionPhase: "capability_execution",
          pendingCapabilityBatchSelection,
          maxBatchCapabilityExecutions: 2,
        },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: observation.capabilityId,
            intent: "Read source A.",
            authoringObjective: "Author the exact query for source A.",
            controls: { source: "A", query: "query A" },
          },
          {
            capabilityId: observation.capabilityId,
            intent: "Read source B.",
            authoringObjective: "Author the exact query for source B.",
            controls: { source: "B", query: "query B" },
          },
        ],
      },
    });
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capabilities",
          invocations: {
            invocation_1: {
              authoringObjective: "Replace the frozen first assignment.",
              controls: { query: "query A" },
            },
            invocation_2: { controls: { query: "query B" } },
          },
        }),
        undefined,
        {
          availableCapabilities: [observation],
          decisionPhase: "capability_execution",
          pendingCapabilityBatchSelection,
          maxBatchCapabilityExecutions: 2,
        },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        expect.objectContaining({
          code: "worker_decision_shape_invalid",
          path: "decision.invocations.invocation_1",
        }),
      ],
    });
  });

  test("keeps an evidence-backed frozen batch pending until execution materialization", async () => {
    const { ledger, call: initialCall } = await openWorkerLedger();
    const evidence = await settleWorkerObservationEvidence(
      ledger,
      initialCall,
      "An unrelated observation is already established.",
    );
    const { call } = evidence;
    const binding = createBinding(ledger, call, observationAdapter());

    const input = buildWorkerDecisionInput(createRequest(), {
      call,
      requestToolResults: evidence.requestToolResults,
      capabilitySource: capabilitySource(ledger, binding, evidence.head),
      selectedCapabilityBatchExecution: {
        invocations: [
          {
            capabilityId: "example.observe",
            intent: "Observe the first target.",
            guidance: "",
          },
          {
            capabilityId: "example.observe",
            intent: "Observe the second target.",
            guidance: "",
          },
        ],
      },
    });

    expect(input.allowedActions).toEqual([
      "return_failure",
      "invoke_capabilities",
    ]);
    expect(JSON.stringify(input.format.schema)).not.toContain("return_result");
    expect(
      runtimeMessageByKind(
        input.context.messages,
        "runtime_worker_capability_execution_assignment",
      ),
    ).toMatchObject({
      pendingCapabilityBatchSelection: [
        { capabilityId: "example.observe" },
        { capabilityId: "example.observe" },
      ],
    });
  });

  test("projects supervision only in selection and not into pending controls refinement", async () => {
    const { ledger, call: firstCall } = await openWorkerLedger();
    const preparedExecute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: "Observed one exact current value.",
    }));
    const adapter: WorkerCapabilityAdapter<TestContext> = {
      ...observationAdapter(),
      prepare: vi.fn(async ({ controls }) =>
        Object.freeze({
          actionFingerprint: `sha256:${"d".repeat(64)}`,
          acceptedControls: controls,
          execute: preparedExecute,
        }),
      ),
    };
    const firstBinding = createBinding(ledger, firstCall, adapter);
    const unrelatedInput = buildWorkerDecisionInput(createRequest(), {
      call: firstCall,
      requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      capabilitySource: capabilitySource(ledger, firstBinding),
    });
    expect(JSON.stringify(unrelatedInput.context.messages)).not.toContain(
      OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
    );
    await firstBinding.execute({
      capabilityId: adapter.descriptor.capabilityId,
      intent: "Observe once.",
      controls: {},
    });
    const secondCall = ledger
      .current()
      .state.calls.find((candidate) => candidate.callId === firstCall.callId);
    if (!secondCall) throw new Error("resumed Worker call missing");
    const secondBinding = createBinding(ledger, secondCall, adapter);
    await secondBinding.execute({
      capabilityId: adapter.descriptor.capabilityId,
      intent: "Observe again.",
      controls: {},
    });
    const warningHead = ledger.current();
    const warningCall = warningHead.state.calls.find(
      (candidate) => candidate.callId === firstCall.callId,
    );
    if (!warningCall) throw new Error("warning Worker call missing");
    const warningBinding = createBinding(ledger, warningCall, adapter);
    const requestResults = requestToolResults(ledger, warningHead, warningCall);

    const selectionInput = buildWorkerDecisionInput(createRequest(), {
      call: warningCall,
      requestToolResults: requestResults,
      capabilitySource: capabilitySource(ledger, warningBinding, warningHead),
    });
    expect(
      runtimeMessageByKind(
        selectionInput.context.messages,
        "runtime_worker_assignment",
      ).operationSupervision,
    ).toEqual([
      expect.objectContaining({
        kind: "runtime_operation_supervision_v1",
        stage: "warning",
        originExecutionId: "capability-execution-2",
      }),
    ]);
    const supervisionEvidence = runtimeMessageByKind(
      selectionInput.context.messages,
      OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
    );
    expect(supervisionEvidence).toMatchObject({
      authority: "canonical_role_call_ledger",
      presenceEffect:
        "passive_evidence_not_user_intent_action_authority_or_new_execution",
      binding: {
        callId: warningCall.callId,
        invocationAttempt: warningCall.activationCount,
        consumers: ["activation_decision", "immediate_presentation_handoff"],
      },
      entries: [
        {
          originExecutionId: "capability-execution-2",
          notice: {
            stage: "warning",
            originExecutionId: "capability-execution-2",
          },
          evidence: {
            kind: "existing_exact_capability_result_lane",
            executionId: "capability-execution-2",
          },
        },
      ],
    });
    expect(JSON.stringify(supervisionEvidence)).not.toContain(
      "generic_capability_result_v1",
    );
    expect(JSON.stringify(supervisionEvidence)).not.toContain(
      '"acceptedAction"',
    );
    expect(
      requestResults.results.find(
        ({ executionId }) => executionId === "capability-execution-2",
      ),
    ).toMatchObject({
      adapterResult: {
        kind: "generic_capability_result_v1",
        ok: true,
      },
    });

    const refinementInput = buildWorkerDecisionInput(createRequest(), {
      call: warningCall,
      requestToolResults: requestResults,
      capabilitySource: capabilitySource(ledger, warningBinding, warningHead),
      selectedCapabilityExecution: {
        capabilityId: adapter.descriptor.capabilityId,
        intent: "Observe a third time.",
        guidance: "",
      },
    });
    expect(
      runtimeMessageByKind(
        refinementInput.context.messages,
        "runtime_worker_capability_execution_assignment",
      ),
    ).not.toHaveProperty("operationSupervision");
    expect(JSON.stringify(refinementInput.context.messages)).not.toContain(
      OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
    );
  });

  test("carries exact cross-call intervention evidence outside compacted results into Worker result authoring", async () => {
    const { ledger, call: firstCall } = await openWorkerLedger(
      undefined,
      "project",
    );
    const actionFingerprint = `sha256:${"e".repeat(64)}`;
    const exactReferenceData = "EXACT_CROSS_CALL_RESULT_MUST_SURVIVE";
    const adapter: WorkerCapabilityAdapter<TestContext> = {
      ...observationAdapter(),
      prepare: vi.fn(async ({ controls }) =>
        Object.freeze({
          actionFingerprint,
          acceptedControls: controls,
          execute: async () => ({
            outcome: "succeeded" as const,
            observedEffect: "observation" as const,
            summary: "Observed the exact cross-call value.",
            referenceData: exactReferenceData,
          }),
        }),
      ),
    };

    const firstBinding = createBinding(ledger, firstCall, adapter);
    await firstBinding.execute({
      capabilityId: adapter.descriptor.capabilityId,
      intent: "Observe the bounded value once.",
      controls: {},
    });
    const firstCallSecondActivation = requireActiveWorkerCall(ledger);
    await createBinding(ledger, firstCallSecondActivation, adapter).execute({
      capabilityId: adapter.descriptor.capabilityId,
      intent: "Observe the bounded value again.",
      controls: {},
    });
    const warnedFirstCall = requireActiveWorkerCall(ledger);
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: warnedFirstCall.parentCallId,
      childCallId: warnedFirstCall.callId,
      outcome: "completed",
      summary: "The first Worker returned after observing the value.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Return the exact current value supplied by prior evidence.",
      workingDirectory: "project",
    });

    const secondCallBeforeIntervention = requireActiveWorkerCall(ledger);
    const intervention = await createBinding(
      ledger,
      secondCallBeforeIntervention,
      adapter,
    ).execute({
      capabilityId: adapter.descriptor.capabilityId,
      intent: "Observe the unchanged bounded value.",
      controls: {},
    });
    expect(intervention).toMatchObject({
      kind: "operation_supervision_intervened",
    });

    const interventionHead = ledger.current();
    const intervenedCall = requireActiveWorkerCall(ledger);
    const results = requestToolResults(
      ledger,
      interventionHead,
      intervenedCall,
    );
    const originResult = results.results.find(
      ({ executionId }) => executionId === "capability-execution-2",
    );
    if (!originResult) throw new Error("supervision origin summary missing");
    expect(originResult).not.toHaveProperty("adapterResult");
    expect(originResult).not.toHaveProperty("referenceData");

    const uncompactedMessage = buildRequestToolResultsMessage(results);
    const uncompactedProjection = JSON.parse(uncompactedMessage.content) as {
      results: readonly Record<string, unknown>[];
    };
    const compactedSource = uncompactedProjection.results.find(
      ({ executionId }) => executionId === "capability-execution-2",
    );
    if (!compactedSource) throw new Error("supervision origin result missing");
    const checkpoint = Object.freeze({
      kind: "runtime_semantic_compaction_checkpoint_v2" as const,
      scopeId: `worker:${intervenedCall.callId}:request-tool-results`,
      requestId: "worker-capability-request",
      currentRequestFingerprint: createSemanticCompactionSha256Fingerprint(
        "ORIGINAL_USER_PROMPT_MUST_NOT_REACH_WORKER",
      ),
      roleId: "worker",
      callId: intervenedCall.callId,
      objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
        intervenedCall.objective!,
      ),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
      sourceRevision: results.sourceRevision,
      sourceDigests: Object.freeze([
        Object.freeze({
          sourceRef: "capability-execution-2",
          sourceFingerprint: createSemanticCompactionSha256Fingerprint(
            JSON.stringify(compactedSource),
          ),
          digest: "The prior Worker observed the exact requested value.",
        }),
      ]),
      continuation: Object.freeze({
        completed: Object.freeze(["Observed the exact requested value."]),
        currentState: "The exact requested value is established.",
        findings: Object.freeze(["The prior observation succeeded."]),
        evidenceRefs: Object.freeze(["capability-execution-2"]),
        artifacts: Object.freeze([]),
        decisions: Object.freeze([]),
        failedApproaches: Object.freeze([]),
        openWork: Object.freeze(["Return the established value."]),
        blockers: Object.freeze([]),
        nextStep: "Return the established value without rereading it.",
      }),
    }) satisfies SemanticCompactionCheckpoint;
    const compactedMessage = buildCompactedRequestToolResultsMessage(
      results,
      checkpoint,
    );

    const seenEvidence: Record<string, unknown>[] = [];
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const messages = input.messages as readonly ChatMessage[];
      seenEvidence.push(
        runtimeMessageByKind(
          messages,
          OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
        ),
      );
      return input.modelStep === WORKER_DECISION_MODEL_STEP
        ? {
            text: workerDecisionText({ action: "return_result" }),
            meta: {},
          }
        : {
            text: "Returned the exact value established by capability-execution-2.",
            meta: {},
          };
    });
    const request = createRequest(invoke, { contextWindowTokens: 32_000 });
    request.contextCompactionStore?.commit(checkpoint);
    const decision = await runWorkerDecision(request, {
      call: intervenedCall,
      requestToolResults: results,
      capabilitySource: capabilitySource(
        ledger,
        createBinding(ledger, intervenedCall, adapter),
        interventionHead,
      ),
    });

    expect(decision).toEqual({
      action: "return_result",
      result: "Returned the exact value established by capability-execution-2.",
    });
    expect(seenEvidence).toHaveLength(2);
    for (const evidence of seenEvidence) {
      expect(evidence).toMatchObject({
        kind: OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
        sourceRevision: interventionHead.revision,
        binding: {
          callId: intervenedCall.callId,
          invocationAttempt: intervenedCall.activationCount,
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
                capabilityId: adapter.descriptor.capabilityId,
                controls: {},
                declaredEffect: "observation",
                workingDirectory: "project",
              },
              receipt: {
                executionId: "capability-execution-2",
                callId: firstCall.callId,
                referenceData: exactReferenceData,
              },
              adapterResult: {
                kind: "generic_capability_result_v1",
                payload: { referenceData: exactReferenceData },
              },
            },
          },
        ],
      });
      expect(JSON.stringify(evidence)).not.toContain('"intent":');
      expect(JSON.stringify(evidence)).not.toContain(
        "Observe the bounded value again.",
      );
    }
    const compactedProjection = runtimeMessageByKind(
      [compactedMessage],
      "runtime_request_tool_results_v1",
    );
    expect(JSON.stringify(compactedProjection)).not.toContain(
      exactReferenceData,
    );
  });

  test("binds heterogeneous frozen batch controls to the exact Luna invocation order", () => {
    const inspectTarget = {
      capabilityId: "inspect_target",
      summary: "Inspect one bounded file window.",
      effect: "observation" as const,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          path: { type: "string" as const, minLength: 1, maxLength: 4_096 },
          start_line: {
            type: "integer" as const,
            minimum: 1,
            maximum: 1_000_000,
          },
          end_line: {
            type: "integer" as const,
            minimum: 1,
            maximum: 1_000_000,
          },
          locator: { type: "string" as const, minLength: 1, maxLength: 4_096 },
          context_lines: { type: "integer" as const, minimum: 1, maximum: 30 },
        },
        required: ["path"],
      },
      selectionControlIds: ["path"],
    } satisfies WorkerCapabilityDescriptor;
    const inspectJson = {
      capabilityId: "inspect_json",
      summary: "Validate and summarize one JSON file.",
      effect: "observation" as const,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          path: { type: "string" as const, minLength: 1, maxLength: 1_024 },
          maxDepth: { type: "integer" as const, minimum: 0, maximum: 6 },
        },
        required: ["path"],
      },
    } satisfies WorkerCapabilityDescriptor;
    const inspectProject = {
      capabilityId: "inspect_project",
      summary: "Inspect a bounded project tree.",
      effect: "observation" as const,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          path: { type: "string" as const, minLength: 0, maxLength: 1_024 },
          depth: { type: "integer" as const, minimum: 0, maximum: 6 },
          maxEntries: { type: "integer" as const, minimum: 1, maximum: 500 },
        },
        required: [],
      },
    } satisfies WorkerCapabilityDescriptor;
    const availableCapabilities = [
      inspectTarget,
      inspectJson,
      inspectProject,
    ] as const;
    const pendingCapabilityBatchSelection = [
      { capabilityId: "inspect_project", intent: "Inspect the project tree." },
      {
        capabilityId: "inspect_target",
        intent: "Inspect index.html.",
        selectionControls: { path: "AbotMarket/index.html" },
      },
      {
        capabilityId: "inspect_target",
        intent: "Inspect styles.css.",
        selectionControls: { path: "AbotMarket/styles.css" },
      },
      {
        capabilityId: "inspect_target",
        intent: "Inspect script.js.",
        selectionControls: { path: "AbotMarket/script.js" },
      },
      { capabilityId: "inspect_json", intent: "Inspect products.json." },
    ] as const;
    const format = createWorkerDecisionFormat({
      capabilities: availableCapabilities,
      maxBatchCapabilityExecutions: 5,
      allowSingleCapabilityInvocation: false,
      pendingCapabilityBatchSelection,
    });

    expect(format.schema).toMatchObject({
      properties: {
        decision: {
          anyOf: [
            {},
            {},
            {
              properties: {
                invocations: {
                  type: "object",
                  properties: {
                    invocation_1: {
                      description: expect.stringContaining("inspect_project"),
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
                      description: expect.stringContaining("inspect_target"),
                      properties: {
                        controls: {
                          properties: {
                            start_line: {},
                            end_line: {},
                            locator: {},
                            context_lines: {},
                          },
                        },
                      },
                    },
                    invocation_3: {
                      description: expect.stringContaining("inspect_target"),
                    },
                    invocation_4: {
                      description: expect.stringContaining("inspect_target"),
                    },
                    invocation_5: {
                      description: expect.stringContaining("inspect_json"),
                      properties: {
                        controls: {
                          properties: { path: {}, maxDepth: {} },
                        },
                      },
                    },
                  },
                  required: [
                    "invocation_1",
                    "invocation_2",
                    "invocation_3",
                    "invocation_4",
                    "invocation_5",
                  ],
                  additionalProperties: false,
                },
              },
            },
          ],
        },
      },
    });
    const serializedSchema = JSON.stringify(format.schema);
    expect(serializedSchema).not.toContain('"items":{"anyOf"');
    expect(serializedSchema).not.toContain('"capabilityId"');
    expect(serializedSchema).not.toContain('"intent"');
    pendingCapabilityBatchSelection.forEach(({ intent }) => {
      expect(serializedSchema).not.toContain(JSON.stringify(intent));
    });
    expect(format.postValidatedSchemaConstraints).toContainEqual({
      keyword: "maxLength",
      path: "/properties/decision/anyOf/2/properties/invocations/properties/invocation_1/properties/controls/properties/path/anyOf/0/maxLength",
    });
    expect(format.postValidatedSchemaConstraints).toContainEqual({
      keyword: "maxLength",
      path: "/properties/decision/anyOf/2/properties/invocations/properties/invocation_5/properties/controls/properties/path/maxLength",
    });

    const executionParseOptions = {
      availableCapabilities,
      maxBatchCapabilityExecutions: 5,
      decisionPhase: "capability_execution" as const,
      pendingCapabilityBatchSelection,
    };
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capabilities",
          invocations: {
            invocation_1: {
              controls: { path: "AbotMarket", depth: 2, maxEntries: 100 },
            },
            invocation_2: {
              controls: {
                start_line: null,
                end_line: null,
                locator: null,
                context_lines: null,
              },
            },
            invocation_3: {
              controls: {
                start_line: null,
                end_line: null,
                locator: null,
                context_lines: null,
              },
            },
            invocation_4: {
              controls: {
                start_line: null,
                end_line: null,
                locator: null,
                context_lines: null,
              },
            },
            invocation_5: {
              controls: { path: "AbotMarket/products.json", maxDepth: 2 },
            },
          },
        }),
        undefined,
        executionParseOptions,
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: "inspect_project",
            intent: "Inspect the project tree.",
            controls: { path: "AbotMarket", depth: 2, maxEntries: 100 },
          },
          {
            capabilityId: "inspect_target",
            intent: "Inspect index.html.",
            controls: { path: "AbotMarket/index.html" },
          },
          {
            capabilityId: "inspect_target",
            intent: "Inspect styles.css.",
            controls: { path: "AbotMarket/styles.css" },
          },
          {
            capabilityId: "inspect_target",
            intent: "Inspect script.js.",
            controls: { path: "AbotMarket/script.js" },
          },
          {
            capabilityId: "inspect_json",
            intent: "Inspect products.json.",
            controls: { path: "AbotMarket/products.json", maxDepth: 2 },
          },
        ],
      },
    });

    const rejectedSwappedControls = parseWorkerDecisionOutput(
      workerDecisionText({
        action: "invoke_capabilities",
        invocations: {
          invocation_1: {
            controls: { path: "AbotMarket", maxDepth: 2 },
          },
          invocation_2: {
            controls: {
              start_line: null,
              end_line: null,
              locator: null,
              context_lines: null,
            },
          },
          invocation_3: {
            controls: {
              start_line: null,
              end_line: null,
              locator: null,
              context_lines: null,
            },
          },
          invocation_4: {
            controls: {
              start_line: null,
              end_line: null,
              locator: null,
              context_lines: null,
            },
          },
          invocation_5: {
            controls: {
              path: "AbotMarket/products.json",
              depth: 2,
              maxEntries: 100,
            },
          },
        },
      }),
      undefined,
      executionParseOptions,
    );
    expect(rejectedSwappedControls).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        {
          code: "worker_capability_controls_unknown",
          path: "decision.invocations.invocation_1.controls.maxDepth",
        },
        {
          code: "worker_capability_controls_unknown",
          path: "decision.invocations.invocation_5.controls.depth",
        },
      ],
    });
    if (rejectedSwappedControls.ok) {
      throw new Error("expected swapped controls to be rejected");
    }
    expect(rejectedSwappedControls.issues[0]?.message).toContain(
      'Pending slot "invocation_1" is frozen to capabilityId "inspect_project".',
    );
    expect(rejectedSwappedControls.issues[0]?.message).toContain(
      'Control "maxDepth" is not allowed',
    );
    expect(rejectedSwappedControls.issues[0]?.message).toContain(
      'Allowed control IDs: ["path","depth","maxEntries"]',
    );
    expect(rejectedSwappedControls.issues[0]?.message).toContain(
      "Required control IDs: []",
    );
    expect(rejectedSwappedControls.issues[1]?.message).toContain(
      'Pending slot "invocation_5" is frozen to capabilityId "inspect_json".',
    );
    expect(rejectedSwappedControls.issues[1]?.message).toContain(
      'Control "depth" is not allowed',
    );
    expect(rejectedSwappedControls.issues[1]?.message).toContain(
      'Allowed control IDs: ["path","maxDepth"]',
    );
    expect(rejectedSwappedControls.issues[1]?.message).toContain(
      'Required control IDs: ["path"]',
    );
  });

  test("merges frozen batch targets by positional slot without exposing them again", () => {
    const inspectTarget = {
      capabilityId: "inspect_target",
      summary: "Inspect one selected target around one locator.",
      effect: "observation" as const,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          path: { type: "string" as const, minLength: 1, maxLength: 4_096 },
          locator: {
            type: "string" as const,
            minLength: 1,
            maxLength: 4_096,
          },
        },
        required: ["path", "locator"],
      },
      selectionControlIds: ["path"],
    } satisfies WorkerCapabilityDescriptor;
    const pendingCapabilityBatchSelection = [
      {
        capabilityId: "inspect_target",
        intent: "Inspect the HTML title.",
        selectionControls: { path: "index.html" },
      },
      {
        capabilityId: "inspect_target",
        intent: "Inspect the stylesheet variables.",
        selectionControls: { path: "style.css" },
      },
    ] as const;

    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capabilities",
          invocations: pendingCapabilityBatchSelection,
        }),
        undefined,
        {
          availableCapabilities: [inspectTarget],
          maxBatchCapabilityExecutions: 2,
        },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: pendingCapabilityBatchSelection,
      },
    });

    const format = createWorkerDecisionFormat({
      capabilities: [inspectTarget],
      maxBatchCapabilityExecutions: 2,
      allowSingleCapabilityInvocation: false,
      pendingCapabilityBatchSelection,
    });
    expect(format.schema).toMatchObject({
      properties: {
        decision: {
          anyOf: [
            {},
            {},
            {
              properties: {
                invocations: {
                  properties: {
                    invocation_1: {
                      properties: {
                        controls: {
                          properties: { locator: {} },
                          required: ["locator"],
                          additionalProperties: false,
                        },
                      },
                    },
                    invocation_2: {
                      properties: {
                        controls: {
                          properties: { locator: {} },
                          required: ["locator"],
                          additionalProperties: false,
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
    });
    const serializedSchema = JSON.stringify(format.schema);
    expect(serializedSchema).not.toContain("index.html");
    expect(serializedSchema).not.toContain("style.css");
    expect(serializedSchema).not.toContain('"path"');

    const executionOptions = {
      availableCapabilities: [inspectTarget],
      maxBatchCapabilityExecutions: 2,
      decisionPhase: "capability_execution" as const,
      pendingCapabilityBatchSelection,
    };
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capabilities",
          invocations: {
            invocation_1: { controls: { locator: "<title>" } },
            invocation_2: { controls: { locator: ":root" } },
          },
        }),
        undefined,
        executionOptions,
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: "inspect_target",
            intent: "Inspect the HTML title.",
            controls: { path: "index.html", locator: "<title>" },
          },
          {
            capabilityId: "inspect_target",
            intent: "Inspect the stylesheet variables.",
            controls: { path: "style.css", locator: ":root" },
          },
        ],
      },
    });

    const drifted = parseWorkerDecisionOutput(
      workerDecisionText({
        action: "invoke_capabilities",
        invocations: {
          invocation_1: {
            controls: { path: "script.js", locator: "<title>" },
          },
          invocation_2: { controls: { locator: ":root" } },
        },
      }),
      undefined,
      executionOptions,
    );
    expect(drifted).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "worker_capability_controls_unknown",
          path: "decision.invocations.invocation_1.controls.path",
        }),
      ],
    });
    if (!drifted.ok) {
      expect(drifted.issues[0]?.message).toContain(
        'Pending slot "invocation_1" is frozen to capabilityId "inspect_target".',
      );
      expect(drifted.issues[0]?.message).toContain(
        'Allowed control IDs: ["locator"]',
      );
    }
  });

  test("withholds completion while parsing selected capability controls", () => {
    const quotedIntent = 'Observe the "selected" path.';
    const controlledCapability = {
      ...observationAdapter().descriptor,
      capabilityId: "example.path",
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          path: { type: "string" as const, minLength: 1, maxLength: 8 },
          locator: { type: "string" as const, minLength: 1, maxLength: 8 },
        },
        required: ["path"],
      },
    };
    const format = createWorkerDecisionFormat({
      capabilities: [controlledCapability],
      allowReturnResult: false,
      allowReturnFailure: false,
      pendingCapabilitySelection: {
        capabilityId: "example.path",
        intent: quotedIntent,
      },
    });
    const executionParseOptions = {
      availableCapabilities: [controlledCapability],
      decisionPhase: "capability_execution",
      allowedActions: ["invoke_capability"],
      pendingCapabilitySelection: {
        capabilityId: "example.path",
        intent: quotedIntent,
      },
    } as const;
    expect(format.schema).toMatchObject({
      type: "object",
      properties: {
        decision: {
          properties: {
            action: { enum: ["invoke_capability"] },
            controls: {
              properties: {
                path: { type: "string", minLength: 1, maxLength: 8 },
                locator: {
                  anyOf: [
                    { type: "string", minLength: 1, maxLength: 8 },
                    { type: "null" },
                  ],
                },
              },
              required: ["path", "locator"],
              additionalProperties: false,
            },
          },
        },
      },
      required: ["decision"],
      additionalProperties: false,
    });
    expect(JSON.stringify(format.schema)).not.toContain(
      JSON.stringify(quotedIntent),
    );
    expect(JSON.stringify(format.schema)).not.toContain("example.path");
    expect(JSON.stringify(format.schema)).not.toContain("return_result");
    expect(JSON.stringify(format.schema)).not.toContain("return_failure");
    expect(format.postValidatedSchemaConstraints).toContainEqual({
      keyword: "maxLength",
      path: "/properties/decision/properties/controls/properties/path/maxLength",
    });
    expect(format.postValidatedSchemaConstraints).toContainEqual({
      keyword: "maxLength",
      path: "/properties/decision/properties/controls/properties/locator/anyOf/0/maxLength",
    });

    for (const action of ["return_result", "return_failure"] as const) {
      expect(
        parseWorkerDecisionOutput(
          workerDecisionText({ action }),
          undefined,
          executionParseOptions,
        ),
      ).toMatchObject({
        ok: false,
        stage: "domain_parser",
        issues: [
          expect.objectContaining({
            code: "worker_terminal_action_unavailable",
            path: "decision.action",
          }),
        ],
      });
    }

    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capability",
          controls: { path: "safe.txt", locator: null },
        }),
        undefined,
        executionParseOptions,
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capability",
        capabilityId: "example.path",
        intent: quotedIntent,
        controls: { path: "safe.txt" },
      },
    });

    for (const [controls, issueCode, path] of [
      [
        {},
        "worker_capability_controls_required_missing",
        "decision.controls.path",
      ],
      [
        { path: "ok", extra: true },
        "worker_capability_controls_unknown",
        "decision.controls.extra",
      ],
      [
        { path: 42 },
        "worker_capability_controls_string_invalid",
        "decision.controls.path",
      ],
      [
        { path: "too-long-path" },
        "worker_capability_controls_string_invalid",
        "decision.controls.path",
      ],
    ] as const) {
      expect(
        parseWorkerDecisionOutput(
          workerDecisionText({
            action: "invoke_capability",
            controls,
          }),
          undefined,
          executionParseOptions,
        ),
      ).toMatchObject({
        ok: false,
        stage: "domain_parser",
        issues: [expect.objectContaining({ code: issueCode, path })],
      });
    }

    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capability",
          capabilityId: "example.path",
          intent: quotedIntent,
          controls: { path: "safe.txt" },
        }),
        undefined,
        executionParseOptions,
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        expect.objectContaining({
          code: "worker_decision_shape_invalid",
          path: "decision",
        }),
      ],
    });
  });

  test("freezes a write target during selection and leaves no target decision for execution", () => {
    const writeCapability = {
      capabilityId: "write_complete_file",
      summary: "Write one complete file.",
      effect: "mutation" as const,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          path: { type: "string" as const, minLength: 1, maxLength: 4_096 },
        },
        required: ["path"],
      },
      selectionControlIds: ["path"],
      requiresPayloadAuthoringObjective: true,
    } satisfies WorkerCapabilityDescriptor;
    const intent = "Create the requested product data file.";
    const authoringObjective =
      "Create the complete product data JSON document requested by the Worker.";
    const selectionFormat = createWorkerDecisionFormat({
      capabilities: [writeCapability],
    });

    expect(selectionFormat.schema).toMatchObject({
      properties: {
        decision: {
          anyOf: [
            {},
            {},
            {
              properties: {
                capabilityId: { enum: ["write_complete_file"] },
                authoringObjective: {
                  type: "string",
                  minLength: 1,
                  maxLength: WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH,
                },
                selectionControls: {
                  properties: {
                    path: {
                      type: "string",
                      minLength: 1,
                      maxLength: 4_096,
                    },
                  },
                  required: ["path"],
                  additionalProperties: false,
                },
              },
              required: [
                "action",
                "capabilityId",
                "intent",
                "authoringObjective",
                "selectionControls",
              ],
            },
          ],
        },
      },
    });
    expect(JSON.stringify(selectionFormat.schema)).not.toContain('"controls"');
    expect(selectionFormat.postValidatedSchemaConstraints).toContainEqual({
      keyword: "maxLength",
      path: "/properties/decision/anyOf/2/properties/selectionControls/properties/path/maxLength",
    });

    const selected = parseWorkerDecisionOutput(
      workerDecisionText({
        action: "invoke_capability",
        capabilityId: "write_complete_file",
        intent,
        authoringObjective,
        selectionControls: { path: "products.json" },
      }),
      undefined,
      { availableCapabilities: [writeCapability] },
    );
    expect(selected).toEqual({
      ok: true,
      decision: {
        action: "invoke_capability",
        capabilityId: "write_complete_file",
        intent,
        authoringObjective,
        selectionControls: { path: "products.json" },
      },
    });
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capability",
          capabilityId: "write_complete_file",
          intent,
          selectionControls: { path: "products.json" },
        }),
        undefined,
        { availableCapabilities: [writeCapability] },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "worker_capability_authoring_objective_invalid",
          path: "decision.authoringObjective",
        }),
      ]),
    });

    const pendingCapabilitySelection = {
      capabilityId: "write_complete_file",
      intent,
      authoringObjective,
      selectionControls: { path: "products.json" },
    } as const;
    const executionFormat = createWorkerDecisionFormat({
      capabilities: [writeCapability],
      pendingCapabilitySelection,
    });
    expect(executionFormat.schema).toMatchObject({
      properties: {
        decision: {
          anyOf: [
            {},
            {},
            {
              properties: {
                controls: {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            },
          ],
        },
      },
    });
    const executionSchema = JSON.stringify(executionFormat.schema);
    expect(executionSchema).not.toContain("products.json");
    expect(executionSchema).not.toContain('"path"');
    expect(executionSchema).not.toContain('"authoringObjective"');
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capability",
          controls: {},
        }),
        undefined,
        {
          availableCapabilities: [writeCapability],
          decisionPhase: "capability_execution",
          pendingCapabilitySelection,
        },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capability",
        capabilityId: "write_complete_file",
        intent,
        authoringObjective,
        controls: { path: "products.json" },
      },
    });

    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capability",
          authoringObjective: "Replace the frozen assignment.",
          controls: {},
        }),
        undefined,
        {
          availableCapabilities: [writeCapability],
          decisionPhase: "capability_execution",
          pendingCapabilitySelection,
        },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        expect.objectContaining({
          code: "worker_decision_shape_invalid",
          path: "decision",
        }),
      ],
    });

    const drifted = parseWorkerDecisionOutput(
      workerDecisionText({
        action: "invoke_capability",
        controls: { path: "script.js" },
      }),
      undefined,
      {
        availableCapabilities: [writeCapability],
        decisionPhase: "capability_execution",
        pendingCapabilitySelection,
      },
    );
    expect(drifted).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: [
        expect.objectContaining({
          code: "worker_capability_controls_unknown",
          path: "decision.controls.path",
        }),
      ],
    });
    if (!drifted.ok) {
      expect(drifted.issues[0]?.message).toContain(
        'Pending capabilityId is "write_complete_file".',
      );
      expect(drifted.issues[0]?.message).toContain("Allowed control IDs: []");
    }
  });

  test("merges a frozen edit target with only the residual instruction", () => {
    const editCapability = {
      capabilityId: "edit_existing_file",
      summary: "Edit one existing file.",
      effect: "mutation" as const,
      controls: {
        type: "object" as const,
        additionalProperties: false as const,
        properties: {
          path: { type: "string" as const, minLength: 1, maxLength: 4_096 },
          instruction: {
            type: "string" as const,
            minLength: 1,
            maxLength: 4_096,
          },
        },
        required: ["path", "instruction"],
      },
      selectionControlIds: ["path"],
    } satisfies WorkerCapabilityDescriptor;
    const pendingCapabilitySelection = {
      capabilityId: "edit_existing_file",
      intent: "Update the heading in the selected document.",
      selectionControls: { path: "index.html" },
    } as const;
    const format = createWorkerDecisionFormat({
      capabilities: [editCapability],
      pendingCapabilitySelection,
    });

    expect(format.schema).toMatchObject({
      properties: {
        decision: {
          anyOf: [
            {},
            {},
            {
              properties: {
                controls: {
                  properties: {
                    instruction: {
                      type: "string",
                      minLength: 1,
                      maxLength: 4_096,
                    },
                  },
                  required: ["instruction"],
                  additionalProperties: false,
                },
              },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(format.schema)).not.toContain('"path"');
    expect(
      parseWorkerDecisionOutput(
        workerDecisionText({
          action: "invoke_capability",
          controls: { instruction: "Replace the visible heading." },
        }),
        undefined,
        {
          availableCapabilities: [editCapability],
          decisionPhase: "capability_execution",
          pendingCapabilitySelection,
        },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capability",
        capabilityId: "edit_existing_file",
        intent: pendingCapabilitySelection.intent,
        controls: {
          path: "index.html",
          instruction: "Replace the visible heading.",
        },
      },
    });
  });

  test("projects only the exact current frozen binding into Worker context", async () => {
    configureDebugLogger({ enabled: true });
    const descriptorSecret = "DESCRIPTOR_SECRET_MUST_NOT_BE_LOGGED";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, call } = await openWorkerLedger(
      undefined,
      "ExampleProject",
    );
    const binding = createBinding(
      ledger,
      call,
      observationAdapter(descriptorSecret),
    );
    const source = capabilitySource(ledger, binding);
    const input = buildWorkerDecisionInput(createRequest(), {
      call,
      requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      capabilitySource: source,
    });
    const assignment = JSON.parse(input.context.messages[2]!.content) as Record<
      string,
      unknown
    >;
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(input.allowedActions).toEqual([
      "return_result",
      "return_failure",
      "invoke_capability",
      "invoke_capabilities",
    ]);
    expect(input.availableCapabilityIds).toEqual(["example.observe"]);
    const flatCatalogPayload = {
      availableCapabilities: [
        {
          capabilityId: "example.observe",
          summary: descriptorSecret,
          effect: "observation",
        },
      ],
    };
    expect(assignment).toEqual({
      kind: "runtime_worker_assignment",
      callId: call.callId,
      parentCallId: call.parentCallId,
      depth: call.depth,
      invocationAttempt: 1,
      objective: call.objective,
      workingDirectory: "ExampleProject",
      capabilitiesAvailable: true,
      ...flatCatalogPayload,
      availableChildRoleIds: [],
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "context.projected",
          completionEvidencePolicy: "explicit_external_outcomes_v1",
          capabilityContextIncluded: true,
          availableCapabilityCount: 1,
          availableCapabilityIds: ["example.observe"],
          availableCapabilityAffordanceCharacterCount:
            JSON.stringify(flatCatalogPayload).length,
          capabilityCatalogProjection: "flat",
          capabilityCatalogGroupCount: 1,
          capabilityCatalogMembershipCount: 1,
          capabilityCatalogGroupedCharacterCount: expect.any(Number),
          capabilityCatalogFlatCharacterCount:
            JSON.stringify(flatCatalogPayload).length,
          workingDirectoryIncluded: true,
          workingDirectoryLength: "ExampleProject".length,
          settledCapabilityResultCount: 0,
          allowedActions: [
            "return_result",
            "return_failure",
            "invoke_capability",
            "invoke_capabilities",
          ],
        }),
      ]),
    );
    expect(input.context.messages[0]!.content).toContain(
      "runtime_worker_assignment.workingDirectory is the canonical base",
    );
    expect(JSON.stringify(logs)).not.toContain(descriptorSecret);

    const referenceData = "FULL_REFERENCE_DATA_REMAINS_IN_REFINEMENT";
    const toolResults = Object.freeze({
      sourceRevision: 7,
      results: Object.freeze([
        Object.freeze({
          executionId: "capability-execution-prior",
          callId: call.callId,
          invocationAttempt: 1,
          capabilityId: "example.prior",
          declaredEffect: "observation" as const,
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: "The current value is established.",
          referenceData,
          references: Object.freeze([
            Object.freeze({
              kind: "tool_target" as const,
              target: "source.txt",
            }),
          ]),
        }),
      ]),
    }) satisfies RequestToolResultsView;
    const executionOptions = {
      call,
      requestToolResults: toolResults,
      capabilitySource: source,
      selectedCapabilityExecution: {
        capabilityId: "example.observe",
        intent: "Read the established current value.",
        guidance: "SELECTED_GUIDANCE_ONLY",
      },
    } as const;
    const executionInput = buildWorkerDecisionInput(
      createRequest(),
      executionOptions,
    );
    expect(executionInput.allowedActions).toEqual([
      "return_failure",
      "invoke_capability",
    ]);
    expect(JSON.stringify(executionInput.format.schema)).not.toContain(
      "return_result",
    );
    const executionCapsule = runtimeMessageByKind(
      executionInput.context.messages,
      "runtime_worker_capability_execution_assignment",
    );
    expect(executionCapsule).toMatchObject({
      callId: call.callId,
      parentCallId: call.parentCallId,
      depth: call.depth,
      invocationAttempt: call.activationCount,
      objective: call.objective,
      workingDirectory: "ExampleProject",
      selectedCapabilityAffordances: [
        { capabilityId: "example.observe", summary: descriptorSecret },
      ],
      pendingCapabilitySelection: {
        capabilityId: "example.observe",
      },
    });
    expect(JSON.stringify(executionCapsule)).not.toContain(
      "Read the established current value.",
    );
    expect(JSON.stringify(executionCapsule)).not.toMatch(
      /availableCapabilities|availableCapabilityCatalog|capabilitiesAvailable|availableChildRoleIds/u,
    );
    expect(
      runtimeMessageByKind(
        executionInput.context.messages,
        "runtime_request_source_v1",
      ),
    ).toMatchObject({
      currentRequest: "ORIGINAL_USER_PROMPT_MUST_NOT_REACH_WORKER",
    });
    expect(
      runtimeMessageByKind(
        executionInput.context.messages,
        "runtime_request_tool_results_v1",
      ),
    ).toEqual(JSON.parse(buildRequestToolResultsMessage(toolResults).content));

    const compactedSource = (
      JSON.parse(buildRequestToolResultsMessage(toolResults).content) as {
        results: readonly Record<string, unknown>[];
      }
    ).results[0]!;
    const compactedSourceRef = compactedSource.executionId;
    if (typeof compactedSourceRef !== "string") {
      throw new Error("compacted source execution id missing");
    }
    const checkpoint = Object.freeze({
      kind: "runtime_semantic_compaction_checkpoint_v2" as const,
      scopeId: `worker:${call.callId}:request-tool-results`,
      requestId: "worker-capability-request",
      currentRequestFingerprint: createSemanticCompactionSha256Fingerprint(
        "ORIGINAL_USER_PROMPT_MUST_NOT_REACH_WORKER",
      ),
      roleId: "worker",
      callId: call.callId,
      objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
        call.objective!,
      ),
      contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
      allowedConsumers: Object.freeze([
        WORKER_DECISION_MODEL_STEP,
        WORKER_RESULT_MODEL_STEP,
      ]),
      sourceRevision: toolResults.sourceRevision,
      sourceDigests: Object.freeze([
        Object.freeze({
          sourceRef: compactedSourceRef,
          sourceFingerprint: createSemanticCompactionSha256Fingerprint(
            JSON.stringify(compactedSource),
          ),
          digest: "The current value is established.",
        }),
      ]),
      continuation: Object.freeze({
        completed: Object.freeze(["Observed the exact current value."]),
        currentState: "The current value is established.",
        findings: Object.freeze(["The current value is established."]),
        evidenceRefs: Object.freeze([compactedSourceRef]),
        artifacts: Object.freeze([]),
        decisions: Object.freeze([]),
        failedApproaches: Object.freeze([]),
        openWork: Object.freeze(["Return the exact current value."]),
        blockers: Object.freeze([]),
        nextStep: "Use the established value without rereading the source.",
      }),
    }) satisfies SemanticCompactionCheckpoint;
    expect(() =>
      assertValidSemanticCompactionCheckpoint(checkpoint),
    ).not.toThrow();
    const compactedMessage = buildCompactedRequestToolResultsMessage(
      toolResults,
      checkpoint,
    );
    expect(
      runtimeMessageByKind(
        buildWorkerDecisionInput(createRequest(), {
          ...executionOptions,
          requestToolResultsContextMessage: compactedMessage,
        }).context.messages,
        "runtime_request_tool_results_v1",
      ),
    ).toEqual(JSON.parse(compactedMessage.content));

    expect(() =>
      buildWorkerDecisionInput(createRequest(), {
        call: { ...call, activationCount: 2 },
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: source,
      }),
    ).toThrow("worker_capability_source_call_mismatch");
    expect(() =>
      buildWorkerDecisionInput(createRequest(), {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: {
          ...source,
          binding: {
            requestId: "worker-capability-request",
            ledger,
            callId: call.callId,
            invocationAttempt: 1,
            capabilities: binding.capabilities,
          },
        },
      }),
    ).toThrow("worker_capability_binding_projection_invalid");
    const otherAuthority = await openWorkerLedger();
    const otherBinding = createBinding(
      otherAuthority.ledger,
      otherAuthority.call,
    );
    expect(() =>
      buildWorkerDecisionInput(createRequest(), {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: {
          binding: otherBinding,
          ledger,
          head: ledger.current(),
        },
      }),
    ).toThrow("worker_capability_binding_projection_invalid");
    expect(() =>
      buildWorkerDecisionInput(
        {
          ...createRequest(),
          requestId: "different-request",
        },
        {
          call,
          requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
          capabilitySource: source,
        },
      ),
    ).toThrow("worker_capability_source_request_mismatch");
  });

  test("projects one settled canonical result through the request-wide block", async () => {
    configureDebugLogger({ enabled: true });
    const resultSecret = "CAPABILITY_RESULT_SECRET_IN_MODEL_CONTEXT";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, call } = await openWorkerLedger();
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });
    const settledHead = await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: call.callId,
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: resultSecret,
    });
    const currentCall = settledHead.state.calls.find(
      (candidate) => candidate.callId === call.callId,
    );
    if (!currentCall) throw new Error("resumed Worker call missing");
    const resume = projectWorkerCapabilityResumeContext(ledger, settledHead, {
      callId: currentCall.callId,
      executionId: "capability-execution-1",
    });
    expect(resume).toMatchObject({
      requestId: "worker-capability-request",
      returnedExecutionId: "capability-execution-1",
      settledResults: [
        {
          executionId: "capability-execution-1",
          capabilityId: "example.observe",
          summary: resultSecret,
        },
      ],
    });
    const binding = createBinding(ledger, currentCall);
    const input = buildWorkerDecisionInput(createRequest(), {
      call: currentCall,
      requestToolResults: requestToolResults(ledger, settledHead, currentCall),
      capabilitySource: capabilitySource(ledger, binding, settledHead),
      capabilityResume: {
        ledger,
        head: settledHead,
        executionId: "capability-execution-1",
      },
    });

    expect(input.context.messages).toHaveLength(4);
    expect(input.context.messages[0]!.content).toContain(
      "the same Worker call resuming after capability execution",
    );
    expect(input.context.messages[0]!.content).toContain(
      "single runtime_request_tool_results_v1 block",
    );
    expect(input.context.messages[0]!.content).toContain(
      "including any capability invoked earlier; prior use does not exhaust it",
    );
    const reconsiderationInput = buildWorkerDecisionInput(createRequest(), {
      call: currentCall,
      requestToolResults: requestToolResults(ledger, settledHead, currentCall),
      capabilitySource: capabilitySource(ledger, binding, settledHead),
      capabilityResume: {
        ledger,
        head: settledHead,
        executionId: "capability-execution-1",
      },
      capabilitySelectionRejection: {
        rejectedSelectionKind: "single",
        rejectedCapabilityIds: ["example.observe"],
        rejectedInvocationCount: 1,
      },
    });
    expect(reconsiderationInput.allowedActions).not.toContain("return_result");
    expect(reconsiderationInput.context.messages[0]!.content).not.toContain(
      "choose return_result when no distinct required outcome remains",
    );
    expect(JSON.parse(input.context.messages[2]!.content)).toMatchObject({
      kind: "runtime_worker_assignment",
      callId: currentCall.callId,
    });
    expect(JSON.parse(input.context.messages[3]!.content)).toEqual({
      kind: "runtime_request_tool_results_v1",
      authority: "reference_data",
      sourceRevision: settledHead.revision,
      results: [
        {
          executionId: "capability-execution-1",
          callId: call.callId,
          invocationAttempt: 1,
          capabilityId: "example.observe",
          declaredEffect: "observation",
          outcome: "succeeded",
          observedEffect: "observation",
          summary: resultSecret,
          adapterResult: {
            kind: "generic_capability_result_v1",
            authority: "capability_adapter",
            status: "executed",
            ok: true,
            payload: {
              outcome: "succeeded",
              observedEffect: "observation",
              summary: resultSecret,
            },
          },
        },
      ],
    });
    expect(() =>
      projectWorkerCapabilityResumeContext(ledger, settledHead, {
        callId: currentCall.callId,
        executionId: "missing-execution",
      }),
    ).toThrow("worker_capability_resume_projection_invalid");
    expect(() =>
      buildWorkerDecisionInput(
        { ...createRequest(), requestId: "different-request" },
        {
          call: currentCall,
          requestToolResults: requestToolResults(
            ledger,
            settledHead,
            currentCall,
          ),
          capabilityResume: {
            ledger,
            head: settledHead,
            executionId: "capability-execution-1",
          },
        },
      ),
    ).toThrow("worker_capability_source_request_mismatch");

    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "capability_result.projected",
          executionId: "capability-execution-1",
          capabilityId: "example.observe",
          outcome: "succeeded",
          observedEffect: "observation",
          summaryLength: resultSecret.length,
          settledCapabilityResultCount: 1,
          settledCapabilityExecutionIds: ["capability-execution-1"],
          referenceMessageCount: 1,
          continuationMessageCount: 1,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(resultSecret);

    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: currentCall.callId,
      invocationAttempt: 2,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });
    expect(() =>
      projectWorkerCapabilityResumeContext(ledger, settledHead, {
        callId: currentCall.callId,
        executionId: "capability-execution-1",
      }),
    ).toThrow("worker_capability_resume_head_stale");
    expect(() =>
      buildWorkerDecisionInput(createRequest(), {
        call: currentCall,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: capabilitySource(ledger, binding, settledHead),
      }),
    ).toThrow("worker_capability_source_head_stale");
  });

  test("reconstructs all settled results for the exact Worker call in canonical order", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, call } = await openWorkerLedger();
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "mutation",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: call.callId,
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "mutation",
      summary: "Target index.html was created.",
    });
    const secondActivation = ledger
      .current()
      .state.calls.find((candidate) => candidate.callId === call.callId);
    if (!secondActivation) throw new Error("second Worker activation missing");
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: secondActivation.activationCount,
      capabilityId: "example.observe",
      declaredEffect: "mutation",
    });
    const settledHead = await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: call.callId,
      executionId: "capability-execution-2",
      outcome: "succeeded",
      observedEffect: "mutation",
      summary: "Target style.css was created.",
    });
    const currentCall = settledHead.state.calls.find(
      (candidate) => candidate.callId === call.callId,
    );
    if (!currentCall) throw new Error("third Worker activation missing");

    const resume = projectWorkerCapabilityResumeContext(ledger, settledHead, {
      callId: currentCall.callId,
      executionId: "capability-execution-2",
    });
    expect(resume).toEqual({
      requestId: "worker-capability-request",
      returnedExecutionId: "capability-execution-2",
      settledResults: [
        expect.objectContaining({
          executionId: "capability-execution-1",
          invocationAttempt: 1,
          summary: "Target index.html was created.",
        }),
        expect.objectContaining({
          executionId: "capability-execution-2",
          invocationAttempt: 2,
          summary: "Target style.css was created.",
        }),
      ],
    });
    expect(Object.isFrozen(resume)).toBe(true);
    expect(Object.isFrozen(resume.settledResults)).toBe(true);
    expect(resume.settledResults.every(Object.isFrozen)).toBe(true);
    expect(
      projectWorkerSettledCapabilityResults({
        ledger,
        head: settledHead,
        call: currentCall,
      }),
    ).toEqual(resume.settledResults);

    const reversedHead = Object.freeze({
      ...settledHead,
      state: Object.freeze({
        ...settledHead.state,
        capabilityExecutions: Object.freeze(
          [...settledHead.state.capabilityExecutions].reverse(),
        ),
      }),
    }) as RoleCallLedgerHead;
    const reversedLedger = Object.freeze({
      current: () => reversedHead,
      apply: vi.fn(),
    }) as unknown as RoleCallLedger;
    expect(() =>
      projectWorkerSettledCapabilityResults({
        ledger: reversedLedger,
        head: reversedHead,
        call: currentCall,
      }),
    ).toThrow("worker_settled_results_execution_invalid");

    const binding = createBinding(ledger, currentCall);
    const input = buildWorkerDecisionInput(createRequest(), {
      call: currentCall,
      requestToolResults: requestToolResults(ledger, settledHead, currentCall),
      capabilitySource: capabilitySource(ledger, binding, settledHead),
      capabilityResume: {
        ledger,
        head: settledHead,
        executionId: "capability-execution-2",
      },
    });
    expect(input.context.messages).toHaveLength(4);
    expect(JSON.parse(input.context.messages[2]!.content)).toMatchObject({
      kind: "runtime_worker_assignment",
      callId: currentCall.callId,
    });
    expect(JSON.parse(input.context.messages[3]!.content)).toEqual({
      kind: "runtime_request_tool_results_v1",
      authority: "reference_data",
      sourceRevision: settledHead.revision,
      results: [
        expect.objectContaining({
          executionId: "capability-execution-1",
          summary: "Target index.html was created.",
        }),
        expect.objectContaining({
          executionId: "capability-execution-2",
          summary: "Target style.css was created.",
        }),
      ],
    });
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "context.projected",
          invocationAttempt: 3,
          settledCapabilityResultCount: 2,
          referenceMessageCount: 1,
          continuationMessageCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.worker",
          event: "capability_result.projected",
          executionId: "capability-execution-2",
          settledCapabilityExecutionIds: [
            "capability-execution-1",
            "capability-execution-2",
          ],
          settledCapabilityResultCount: 2,
          referenceMessageCount: 1,
          continuationMessageCount: 1,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain("Target index.html");
    expect(JSON.stringify(logs)).not.toContain("Target style.css");
    expect(() =>
      projectWorkerCapabilityResumeContext(ledger, settledHead, {
        callId: currentCall.callId,
        executionId: "capability-execution-1",
      }),
    ).toThrow("worker_capability_resume_projection_invalid");
  });

  test("shared settled-result projection is empty initially and never leaks another Worker call", async () => {
    const { ledger, call } = await openWorkerLedger();
    expect(
      projectWorkerSettledCapabilityResults({
        ledger,
        head: ledger.current(),
        call,
      }),
    ).toEqual([]);

    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: 1,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: call.callId,
      executionId: "capability-execution-1",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "First Worker observed cobalt.",
    });
    await commit(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: call.callId,
      outcome: "completed",
      summary: "First Worker completed.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Observe a second bounded value.",
    });
    const secondWorker = ledger
      .current()
      .state.calls.find(
        (candidate) => candidate.callId === ledger.current().state.activeCallId,
      );
    if (!secondWorker) throw new Error("second Worker call missing");
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: secondWorker.callId,
      invocationAttempt: secondWorker.activationCount,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });
    const secondSettledHead = await commit(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: secondWorker.callId,
      executionId: "capability-execution-2",
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Second Worker observed amber.",
    });
    const secondWorkerResumed = secondSettledHead.state.calls.find(
      (candidate) => candidate.callId === secondWorker.callId,
    );
    if (!secondWorkerResumed) throw new Error("second Worker resume missing");

    const projection = projectWorkerSettledCapabilityResults({
      ledger,
      head: secondSettledHead,
      call: secondWorkerResumed,
    });
    expect(projection).toEqual([
      expect.objectContaining({
        executionId: "capability-execution-2",
        callId: secondWorker.callId,
        summary: "Second Worker observed amber.",
      }),
    ]);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(projection.every(Object.isFrozen)).toBe(true);

    const runningHead = await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: secondWorkerResumed.callId,
      invocationAttempt: secondWorkerResumed.activationCount,
      capabilityId: "example.observe",
      declaredEffect: "observation",
    });
    const waitingWorker = runningHead.state.calls.find(
      (candidate) => candidate.callId === secondWorkerResumed.callId,
    );
    if (!waitingWorker) throw new Error("waiting Worker call missing");
    expect(() =>
      projectWorkerSettledCapabilityResults({
        ledger,
        head: runningHead,
        call: waitingWorker,
      }),
    ).toThrow("worker_settled_results_call_invalid");
    expect(() =>
      projectWorkerSettledCapabilityResults({
        ledger,
        head: secondSettledHead,
        call: secondWorkerResumed,
      }),
    ).toThrow("worker_settled_results_head_stale");
  });

  test("runs one structured capability decision without production execution", async () => {
    const intent = 'Read the exact "current" value.';
    const { ledger, call } = await openWorkerLedger();
    const binding = createBinding(ledger, call);
    let invocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      const schema = JSON.stringify(input.format);
      if (invocation === 1) {
        expect(schema).not.toContain('"controls"');
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "example.observe",
            intent,
          }),
          meta: {},
        };
      }
      expect(schema).toContain('"controls"');
      expect(schema).not.toContain('"capabilityId"');
      expect(schema).not.toContain('"intent"');
      expect(schema).not.toContain(JSON.stringify(intent));
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          controls: {},
        }),
        meta: {},
      };
    });
    const request = createRequest(invoke);

    await expect(
      runWorkerDecision(request, {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: capabilitySource(ledger, binding),
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: "example.observe",
      intent,
      controls: {},
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        modelStep: WORKER_DECISION_MODEL_STEP,
        format: expect.objectContaining({
          schema: expect.objectContaining({
            properties: expect.objectContaining({
              decision: expect.objectContaining({
                anyOf: expect.arrayContaining([
                  expect.objectContaining({
                    properties: expect.objectContaining({
                      action: { type: "string", enum: ["invoke_capability"] },
                      capabilityId: {
                        type: "string",
                        enum: ["example.observe"],
                      },
                    }),
                  }),
                ]),
              }),
            }),
          }),
        }),
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
  });

  test("materializes opted-in empty controls without a second structured capability decision", async () => {
    const intent = "Create the selected file.";
    const { ledger, call } = await openWorkerLedger();
    const adapter: WorkerCapabilityAdapter<TestContext> = {
      descriptor: {
        capabilityId: "example.write",
        summary: "Create one complete file.",
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
      },
      execute: vi.fn(),
    };
    const binding = createBinding(ledger, call, adapter);
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: workerDecisionText({
        action: "invoke_capability",
        capabilityId: "example.write",
        intent,
        selectionControls: { path: "products.json" },
      }),
      meta: {},
    }));

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: capabilitySource(ledger, binding),
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: "example.write",
      intent,
      controls: { path: "products.json" },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
  });

  test("repairs evidence-backed completion before pending controls execute", async () => {
    const intent = "Observe the selected value.";
    const { ledger, call: initialCall } = await openWorkerLedger();
    const evidence = await settleWorkerObservationEvidence(
      ledger,
      initialCall,
      "An unrelated observation is already established.",
    );
    const { call } = evidence;
    const adapter = observationAdapter();
    const binding = createBinding(ledger, call, adapter);
    let invocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      if (invocation === 1) {
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "example.observe",
            intent,
          }),
          meta: {},
        };
      }
      expect(input.modelStep).toBe(CAPABILITY_CONTROLS_MODEL_STEP);
      expect(JSON.stringify(input.format)).not.toContain("return_result");
      if (invocation === 2) {
        return {
          text: workerDecisionText({ action: "return_result" }),
          meta: {},
        };
      }
      expect(asChatMessages(input.messages).at(-1)).toMatchObject({
        role: "system",
        content: expect.stringContaining("worker_terminal_action_unavailable"),
      });
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          controls: {},
        }),
        meta: {},
      };
    });
    const getExecutionGuidance = vi.fn(
      async () => "Execute the selected observation.",
    );
    const baseRequest = createRequest(invoke);
    const request = createTestRequestExecutionScope({
      ...baseRequest,
      workerCapabilityProvider: {
        ...baseRequest.workerCapabilities.provider,
        getExecutionGuidance,
      },
    });

    await expect(
      runWorkerDecision(request, {
        call,
        requestToolResults: evidence.requestToolResults,
        capabilitySource: capabilitySource(ledger, binding, evidence.head),
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: "example.observe",
      intent,
      controls: {},
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(getExecutionGuidance).toHaveBeenCalledExactlyOnceWith(
      "example.observe",
    );
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  test("repairs no-evidence completion before optional controls execute", async () => {
    const intent = "Inspect the bounded project with its default controls.";
    const { ledger, call } = await openWorkerLedger();
    const adapter: WorkerCapabilityAdapter<TestContext> = {
      descriptor: {
        capabilityId: "example.optional",
        summary: "Inspect one bounded project.",
        effect: "observation",
        controlsRefinement: "mechanical_when_complete",
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            depth: { type: "integer", minimum: 0, maximum: 6 },
          },
          required: [],
        },
      },
      execute: vi.fn(),
    };
    const binding = createBinding(ledger, call, adapter);
    let invocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      if (invocation === 1) {
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "example.optional",
            intent,
          }),
          meta: {},
        };
      }
      if (invocation === 2) {
        expect(input.modelStep).toBe(CAPABILITY_CONTROLS_MODEL_STEP);
        expect(JSON.stringify(input.format)).not.toContain("return_result");
        return {
          text: workerDecisionText({ action: "return_result" }),
          meta: {},
        };
      }
      expect(input.modelStep).toBe(CAPABILITY_CONTROLS_MODEL_STEP);
      expect(asChatMessages(input.messages).at(-1)).toMatchObject({
        role: "system",
        content: expect.stringContaining("worker_terminal_action_unavailable"),
      });
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          controls: {},
        }),
        meta: {},
      };
    });

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: capabilitySource(ledger, binding),
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: "example.optional",
      intent,
      controls: {},
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
  });

  test("repairs invalid controls before merging the frozen capability selection", async () => {
    const intent = "Read the exact current value.";
    const { ledger, call } = await openWorkerLedger();
    const adapter: WorkerCapabilityAdapter<TestContext> = {
      descriptor: {
        capabilityId: "example.observe",
        summary: "Observe one exact current value.",
        effect: "observation",
        controls: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 64 },
          },
          required: ["query"],
        },
      },
      execute: vi.fn(),
    };
    const binding = createBinding(ledger, call, adapter);
    let invocation = 0;
    let executionMessages:
      | readonly Readonly<{ role: string; content: string }>[]
      | undefined;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      if (invocation === 1) {
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "example.observe",
            intent,
          }),
          meta: {},
        };
      }
      if (invocation === 2) {
        executionMessages = asChatMessages(input.messages);
        expect(JSON.stringify(input.format)).not.toContain('"capabilityId"');
        expect(JSON.stringify(input.format)).not.toContain('"intent"');
        expect(
          runtimeMessageByKind(
            input.messages,
            "runtime_worker_capability_execution_assignment",
          ),
        ).toMatchObject({
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
        expect(JSON.stringify(executionMessages)).not.toContain(intent);
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            controls: {},
          }),
          meta: {},
        };
      }
      expect(executionMessages).toBeDefined();
      const messages = asChatMessages(input.messages);
      expect(messages.slice(0, -1)).toEqual(executionMessages);
      expect(messages.at(-1)).toMatchObject({
        role: "system",
        content: expect.stringContaining(
          "worker_capability_controls_required_missing",
        ),
      });
      expect(JSON.stringify(input.messages)).toContain(
        "worker_capability_controls_required_missing",
      );
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          controls: { query: "current cobalt value" },
        }),
        meta: {},
      };
    });

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: capabilitySource(ledger, binding),
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: "example.observe",
      intent,
      controls: { query: "current cobalt value" },
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
  });

  test("reopens the full catalog once when single-capability controls return a local failure", async () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, call } = await openWorkerLedger();
    const rejectedExecute = vi.fn();
    const selectedExecute = vi.fn();
    const binding = createWorkerCapabilityBinding({
      requestId: "worker-capability-request",
      context: Object.freeze({ marker: "context-1" }),
      call,
      ledger,
      adapters: [
        {
          descriptor: {
            capabilityId: "example.observe",
            summary: "Observe one current value.",
            effect: "observation",
            controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          },
          execute: rejectedExecute,
        },
        {
          descriptor: {
            capabilityId: "example.mutate",
            summary: "Create the required artifact.",
            effect: "mutation",
            controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          },
          execute: selectedExecute,
        },
      ],
    });
    const secretReason =
      "LOCAL_REFINEMENT_REASON_MUST_NOT_REACH_REOPENED_MODEL_CONTEXT";
    const guidanceBlocker =
      "The pending observation cannot establish the requested mutation.";
    const getExecutionGuidance = vi.fn(async (capabilityId: string) =>
      capabilityId === "example.observe"
        ? guidanceBlocker
        : "Confirm the selected mutation before execution.",
    );
    let invocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      const messages = asChatMessages(input.messages)
        .map(({ content }) => content)
        .join("\n");
      const format = JSON.stringify(input.format);
      if (invocation === 1) {
        expect(format).toContain("example.observe");
        expect(format).toContain("example.mutate");
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "example.observe",
            intent: "Create the required artifact.",
          }),
          meta: {},
        };
      }
      if (invocation === 2) {
        expect(format).toContain('"controls"');
        expect(format).not.toContain('"capabilityId"');
        expect(format).not.toContain('"intent"');
        expect(format).not.toContain("example.mutate");
        expect(messages).not.toContain("capabilitySelectionRejection");
        expect(messages).toContain(guidanceBlocker);
        const capsule = runtimeMessageByKind(
          input.messages,
          "runtime_worker_capability_execution_assignment",
        );
        expect(capsule).toMatchObject({
          selectedCapabilityAffordances: [
            { capabilityId: "example.observe", effect: "observation" },
          ],
          pendingCapabilitySelection: {
            capabilityId: "example.observe",
          },
        });
        expect(JSON.stringify(capsule)).not.toContain(
          "Create the required artifact.",
        );
        expect(JSON.stringify(capsule)).not.toContain("example.mutate");
        return {
          text: workerDecisionText({
            action: "return_failure",
            reason: secretReason,
          }),
          meta: {},
        };
      }
      if (invocation === 3) {
        expect(format).not.toContain('"controls"');
        expect(format).toContain("example.observe");
        expect(format).toContain("example.mutate");
        expect(format).not.toContain("return_result");
        expect(format).toContain("return_failure");
        expect(messages).toContain("capabilitySelectionRejection");
        expect(messages).not.toContain(secretReason);
        expect(messages).not.toContain(guidanceBlocker);
        expect(
          hasRuntimeMessageKind(
            input.messages,
            "runtime_worker_capability_execution_assignment",
          ),
        ).toBe(false);
        expect(
          runtimeMessageByKind(input.messages, "runtime_worker_assignment"),
        ).toMatchObject({
          capabilitySelectionRejection: {
            rejectedSelectionKind: "single",
            rejectedCapabilityIds: ["example.observe"],
            rejectedInvocationCount: 1,
          },
        });
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "example.mutate",
            intent: "Create the required artifact.",
          }),
          meta: {},
        };
      }
      expect(format).toContain('"controls"');
      expect(format).not.toContain('"capabilityId"');
      expect(format).not.toContain('"intent"');
      expect(format).not.toContain("example.observe");
      expect(format).not.toContain("return_result");
      expect(format).not.toContain("return_failure");
      expect(messages).not.toContain("capabilitySelectionRejection");
      expect(
        runtimeMessageByKind(
          input.messages,
          "runtime_worker_capability_execution_assignment",
        ),
      ).toMatchObject({
        selectedCapabilityAffordances: [
          { capabilityId: "example.mutate", effect: "mutation" },
        ],
        pendingCapabilitySelection: {
          capabilityId: "example.mutate",
        },
      });
      expect(
        runtimeMessageByKind(
          input.messages,
          "runtime_worker_capability_execution_assignment",
        ).pendingCapabilitySelection,
      ).not.toHaveProperty("intent");
      if (invocation === 4) {
        return {
          text: workerDecisionText({
            action: "return_failure",
            reason: "Attempt to veto the reaffirmed selection.",
          }),
          meta: {},
        };
      }
      expect(messages).toContain("worker_terminal_action_unavailable");
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          controls: {},
        }),
        meta: {},
      };
    });

    const baseRequest = createRequest(invoke);
    const request = createTestRequestExecutionScope({
      ...baseRequest,
      workerCapabilityProvider: {
        ...baseRequest.workerCapabilities.provider,
        getExecutionGuidance,
      },
    });

    await expect(
      runWorkerDecision(request, {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: Object.freeze({
          binding,
          ledger,
          head: ledger.current(),
        }),
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: "example.mutate",
      intent: "Create the required artifact.",
      controls: {},
    });
    expect(invoke).toHaveBeenCalledTimes(5);
    expect(getExecutionGuidance).toHaveBeenNthCalledWith(1, "example.observe");
    expect(getExecutionGuidance).toHaveBeenNthCalledWith(2, "example.mutate");
    expect(rejectedExecute).not.toHaveBeenCalled();
    expect(selectedExecute).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
    const reopened = consoleLog.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter(({ event }) => event === "capability_selection.reopened");
    expect(reopened).toEqual([
      expect.objectContaining({
        rejectedSelectionKind: "single",
        rejectedCapabilityIds: ["example.observe"],
        rejectedInvocationCount: 1,
        rejectedSelectionExecutionStarted: false,
        reopenAttempt: 1,
        maxReopenAttempts: 1,
      }),
    ]);
    expect(JSON.stringify(reopened)).not.toContain(secretReason);
  });

  test("binds a reaffirmed observation batch to execution", async () => {
    const { ledger, call } = await openWorkerLedger();
    const rejectedExecute = vi.fn();
    const selectedExecute = vi.fn();
    const binding = createWorkerCapabilityBinding({
      requestId: "worker-capability-request",
      context: Object.freeze({ marker: "context-1" }),
      call,
      ledger,
      adapters: [
        {
          descriptor: {
            capabilityId: "example.wait",
            summary: "Wait for one existing process.",
            effect: "observation",
            controlsRefinement: "mechanical_when_complete",
            controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          },
          execute: rejectedExecute,
        },
        {
          descriptor: {
            capabilityId: "example.wait.secondary",
            summary: "Wait for another existing process.",
            effect: "observation",
            controlsRefinement: "mechanical_when_complete",
            controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          },
          execute: rejectedExecute,
        },
        {
          descriptor: {
            capabilityId: "example.mutate",
            summary: "Create one required artifact.",
            effect: "mutation",
            controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          },
          execute: selectedExecute,
        },
      ],
    });
    let invocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      if (invocation === 1) {
        return {
          text: workerDecisionText({
            action: "invoke_capabilities",
            invocations: [
              {
                capabilityId: "example.wait",
                intent: "Create the stylesheet.",
              },
              {
                capabilityId: "example.wait.secondary",
                intent: "Create the script.",
              },
            ],
          }),
          meta: {},
        };
      }
      if (invocation === 2) {
        return {
          text: workerDecisionText({
            action: "return_failure",
            reason: "The pending observation batch cannot create files.",
          }),
          meta: {},
        };
      }
      if (invocation === 3) {
        expect(
          JSON.parse(asChatMessages(input.messages).at(-1)!.content),
        ).toMatchObject({
          capabilitySelectionRejection: {
            rejectedSelectionKind: "batch",
            rejectedCapabilityIds: ["example.wait", "example.wait.secondary"],
            rejectedInvocationCount: 2,
          },
        });
        return {
          text: workerDecisionText({
            action: "invoke_capabilities",
            invocations: [
              {
                capabilityId: "example.wait",
                intent: "Wait for the required process.",
              },
              {
                capabilityId: "example.wait.secondary",
                intent: "Wait for the other required process.",
              },
            ],
          }),
          meta: {},
        };
      }
      const format = JSON.stringify(input.format);
      expect(format).toContain("invoke_capabilities");
      expect(format).not.toContain("return_result");
      expect(format).not.toContain("return_failure");
      return {
        text: workerDecisionText({
          action: "invoke_capabilities",
          invocations: {
            invocation_1: { controls: {} },
            invocation_2: { controls: {} },
          },
        }),
        meta: {},
      };
    });

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: Object.freeze({
          binding,
          ledger,
          head: ledger.current(),
        }),
      }),
    ).resolves.toMatchObject({
      action: "invoke_capabilities",
      invocations: [
        { capabilityId: "example.wait", controls: {} },
        { capabilityId: "example.wait.secondary", controls: {} },
      ],
    });
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(rejectedExecute).not.toHaveBeenCalled();
    expect(selectedExecute).not.toHaveBeenCalled();
    expect(ledger.current().state.capabilityExecutions).toEqual([]);
  });

  test("selects directly from a compact grouped catalog and refines only the chosen capability", async () => {
    const { ledger, call } = await openWorkerLedger();
    const adapters = [
      ["read.one", "read"],
      ["read.two", "read"],
      ["write.one", "write"],
      ["write.two", "write"],
      ["web.one", "web"],
      ["memory.one", "memory"],
      ["other.one", "other"],
      ["other.two", "other"],
    ].map(
      ([capabilityId, catalogGroup]) =>
        ({
          descriptor: {
            capabilityId: capabilityId!,
            summary: `Capability ${capabilityId} reads an exact current value without changing external state.`,
            effect: "observation" as const,
            controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
            catalogGroups: Object.freeze([catalogGroup!]),
          },
          execute: vi.fn(async () => ({
            outcome: "succeeded" as const,
            observedEffect: "observation" as const,
            summary: `Executed ${capabilityId}.`,
          })),
        }) satisfies WorkerCapabilityAdapter<TestContext>,
    );
    const binding = createWorkerCapabilityBinding({
      requestId: "worker-capability-request",
      context: Object.freeze({ marker: "context-1" }),
      call,
      ledger,
      adapters,
    });
    let invocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      const messages = asChatMessages(input.messages)
        .map(({ content }) => content)
        .join("\n");
      const format = JSON.stringify(input.format);
      if (invocation === 1) {
        expect(input.format).toMatchObject({ name: "worker_decision" });
        expect(messages).toContain("availableCapabilityCatalog");
        expect(messages).toContain(
          '"columns":["capabilityId","summary","effect","catalogGroups"]',
        );
        expect(messages).toContain(
          '["read.one","Capability read.one reads an exact current value without changing external state.","observation",["read"]]',
        );
        expect(messages).toContain(
          "Capability read.one reads an exact current value",
        );
        expect(messages).not.toContain('"controls"');
        expect(format).toContain("read.one");
        expect(format).toContain("write.one");
        expect(format).not.toContain("select_capability_group");
        expect(format).not.toContain("reselect_capability_group");
        expect(format).toContain("return_result");
        expect(format).toContain("return_failure");
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "read.one",
            intent: "Read the required current value.",
          }),
          meta: {},
        };
      }
      const capsule = runtimeMessageByKind(
        input.messages,
        "runtime_worker_capability_execution_assignment",
      );
      expect(capsule).toMatchObject({
        selectedCapabilityAffordances: [
          {
            capabilityId: "read.one",
            summary:
              "Capability read.one reads an exact current value without changing external state.",
            effect: "observation",
          },
        ],
        pendingCapabilitySelection: {
          capabilityId: "read.one",
        },
      });
      expect(JSON.stringify(capsule)).not.toContain(
        "Read the required current value.",
      );
      expect(capsule).not.toHaveProperty("availableCapabilities");
      expect(capsule).not.toHaveProperty("availableCapabilityCatalog");
      expect(capsule).not.toHaveProperty("capabilitiesAvailable");
      expect(capsule).not.toHaveProperty("availableChildRoleIds");
      expect(messages).not.toContain("read.two");
      expect(messages).not.toContain("write.one");
      expect(format).not.toContain('"capabilityId"');
      expect(format).not.toContain('"intent"');
      expect(format).not.toContain("read.two");
      expect(format).not.toContain("write.one");
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          controls: {},
        }),
        meta: {},
      };
    });

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: Object.freeze({
          binding,
          ledger,
          head: ledger.current(),
        }),
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: "read.one",
      intent: "Read the required current value.",
      controls: {},
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("exposes only the Worker call scoped catalog to selection and guidance", async () => {
    const { ledger, call } = await openWorkerLedger(["read"]);
    const adapters: readonly WorkerCapabilityAdapter<TestContext>[] = [
      {
        descriptor: {
          capabilityId: "read.current",
          summary: "Read the exact current value.",
          effect: "observation",
          controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          catalogGroups: ["read", "shared"],
        },
        execute: vi.fn(),
      },
      {
        descriptor: {
          capabilityId: "write.hidden",
          summary: "Write an unrelated external value.",
          effect: "mutation",
          controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          catalogGroups: ["write", "shared"],
        },
        execute: vi.fn(),
      },
    ];
    const binding = createWorkerCapabilityBinding({
      requestId: "worker-capability-request",
      context: Object.freeze({ marker: "context-1" }),
      call,
      ledger,
      adapters,
    });
    const loadGuidance = vi.fn(async () => "Use exact current evidence.");
    let invocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      const serialized = JSON.stringify({
        format: input.format,
        messages: input.messages,
      });
      expect(serialized).toContain("read.current");
      expect(serialized).not.toContain("write.hidden");
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          ...(invocation === 1
            ? {
                capabilityId: "read.current",
                intent: "Read the exact current value.",
              }
            : { controls: {} }),
        }),
        meta: {},
      };
    });
    const request = createTestRequestExecutionScope({
      ...createRequest(invoke),
      workerCapabilityProvider: {
        getDescriptors: () => adapters.map(({ descriptor }) => descriptor),
        getAdapters: () => adapters,
        getExecutionGuidance: loadGuidance,
      },
    });

    await expect(
      runWorkerDecision(request, {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: capabilitySource(ledger, binding),
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: "read.current",
      intent: "Read the exact current value.",
      controls: {},
    });
    expect(loadGuidance).toHaveBeenCalledExactlyOnceWith("read.current");
    expect(
      binding.capabilities.map(({ capabilityId }) => capabilityId),
    ).toEqual(["read.current"]);
  });

  test("uses the flat catalog when multi-group serialization is larger", async () => {
    const { ledger, call } = await openWorkerLedger();
    const catalogGroups = Object.freeze(
      Array.from({ length: 16 }, (_, index) => `group-${index + 1}`),
    );
    const adapters = Array.from({ length: 8 }, (_, index) => {
      const capabilityId = `observe.${index + 1}`;
      return {
        descriptor: {
          capabilityId,
          summary: `Observe bounded value ${index + 1}.`,
          effect: "observation" as const,
          controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
          catalogGroups,
        },
        execute: vi.fn(async () => ({
          outcome: "succeeded" as const,
          observedEffect: "observation" as const,
          summary: `Executed ${capabilityId}.`,
        })),
      } satisfies WorkerCapabilityAdapter<TestContext>;
    });
    const binding = createWorkerCapabilityBinding({
      requestId: "worker-capability-request",
      context: Object.freeze({ marker: "context-1" }),
      call,
      ledger,
      adapters,
    });
    let invocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      invocation += 1;
      const messages = asChatMessages(input.messages)
        .map(({ content }) => content)
        .join("\n");
      expect(input.format).toMatchObject({ name: "worker_decision" });
      expect(JSON.stringify(input.format)).not.toContain(
        "select_capability_group",
      );
      if (invocation === 1) {
        expect(messages).toContain("availableCapabilities");
        expect(messages).not.toContain("availableCapabilityCatalog");
        expect(messages).toContain("Observe bounded value 1.");
      }
      return {
        text: workerDecisionText({
          action: "invoke_capability",
          ...(invocation === 1
            ? {
                capabilityId: "observe.1",
                intent: "Read one bounded value.",
              }
            : { controls: {} }),
        }),
        meta: {},
      };
    });

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: capabilitySource(ledger, binding),
      }),
    ).resolves.toEqual({
      action: "invoke_capability",
      capabilityId: "observe.1",
      intent: "Read one bounded value.",
      controls: {},
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("executes one canonical capability sub-turn and consumes its result on Worker re-entry", async () => {
    const opaqueObservation = "Opaque observed token: COBALT-47.";
    const { ledger, call: firstCall } = await openWorkerLedger();
    const execute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      observedEffect: "observation" as const,
      summary: opaqueObservation,
    }));
    const adapter: WorkerCapabilityAdapter<TestContext> = {
      descriptor: {
        capabilityId: "example.observe",
        summary: "Observe one opaque current value.",
        effect: "observation",
        controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA,
      },
      execute,
    };
    const firstBinding = createBinding(ledger, firstCall, adapter);
    let modelInvocation = 0;
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      modelInvocation += 1;
      if (modelInvocation === 1) {
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            capabilityId: "example.observe",
            intent: "  Read the opaque current value.  ",
          }),
          meta: {},
        };
      }
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      if (modelInvocation === 2) {
        const format = JSON.stringify(input.format);
        expect(format).toContain('"controls"');
        expect(format).not.toContain('"capabilityId"');
        expect(format).not.toContain('"intent"');
        expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({
          pendingCapabilitySelection: {
            capabilityId: "example.observe",
          },
        });
        expect(JSON.stringify(messages)).not.toContain(
          "Read the opaque current value.",
        );
        return {
          text: workerDecisionText({
            action: "invoke_capability",
            controls: {},
          }),
          meta: {},
        };
      }
      if (!secondCall) {
        throw new Error("resumed Worker call missing");
      }
      if (input.modelStep === WORKER_RESULT_MODEL_STEP) {
        expect(input).not.toHaveProperty("format");
        expect(messages).toHaveLength(4);
        const authorAssignment = JSON.parse(messages[3]!.content) as Record<
          string,
          unknown
        >;
        expect(authorAssignment).toEqual({
          kind: "runtime_worker_result_assignment",
          callId: secondCall.callId,
          parentCallId: secondCall.parentCallId,
          depth: secondCall.depth,
          invocationAttempt: secondCall.activationCount,
          objective: secondCall.objective,
        });
        expect(messages[3]!.content).not.toContain("availableCapabilities");
        expect(JSON.parse(messages[2]!.content)).toMatchObject({
          kind: "runtime_request_tool_results_v1",
          results: [
            {
              executionId: "capability-execution-1",
              summary: opaqueObservation,
            },
          ],
        });
        expect(
          messages.filter(({ content }) => content.includes(opaqueObservation)),
        ).toHaveLength(1);
        return {
          text: "Consumed canonical evidence from capability-execution-1.",
          meta: {},
        };
      }
      expect(messages).toHaveLength(4);
      expect(JSON.parse(messages[2]!.content)).toMatchObject({
        kind: "runtime_worker_assignment",
        callId: secondCall.callId,
      });
      const resultCapsule = JSON.parse(messages[3]!.content) as {
        kind?: unknown;
        results?: unknown;
      };
      expect(resultCapsule).toEqual(
        expect.objectContaining({
          kind: "runtime_request_tool_results_v1",
          results: [
            expect.objectContaining({
              executionId: "capability-execution-1",
              summary: opaqueObservation,
            }),
          ],
        }),
      );
      expect(
        messages.filter(({ content }) => content.includes(opaqueObservation)),
      ).toHaveLength(1);
      return {
        text: workerDecisionText({ action: "return_result" }),
        meta: {},
      };
    });
    const request = createRequest(invoke);

    const firstDecision = await runWorkerDecision(request, {
      call: firstCall,
      requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
      capabilitySource: capabilitySource(ledger, firstBinding),
    });
    expect(firstDecision).toEqual({
      action: "invoke_capability",
      capabilityId: "example.observe",
      intent: "Read the opaque current value.",
      controls: {},
    });
    if (firstDecision.action !== "invoke_capability") {
      throw new Error("expected capability decision");
    }

    const executionReference = await firstBinding.execute({
      capabilityId: firstDecision.capabilityId,
      intent: firstDecision.intent,
      controls: firstDecision.controls,
    });
    expect(executionReference).toEqual({
      executionId: "capability-execution-1",
    });
    if ("commit" in executionReference) {
      throw new Error("unexpected operation supervision intervention");
    }

    const settledHead = ledger.current();
    const execution = settledHead.state.capabilityExecutions.find(
      (candidate) => candidate.executionId === executionReference.executionId,
    );
    const secondCall = settledHead.state.calls.find(
      (candidate) => candidate.callId === firstCall.callId,
    );
    if (!execution || !secondCall) {
      throw new Error("canonical capability result missing");
    }
    const secondBinding = createBinding(ledger, secondCall, adapter);
    const secondDecision = await runWorkerDecision(request, {
      call: secondCall,
      requestToolResults: requestToolResults(ledger, settledHead, secondCall),
      capabilitySource: capabilitySource(ledger, secondBinding, settledHead),
      capabilityResume: {
        ledger,
        head: settledHead,
        executionId: execution.executionId,
      },
    });

    expect(secondDecision).toEqual({
      action: "return_result",
      result: "Consumed canonical evidence from capability-execution-1.",
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      context: Object.freeze({ marker: "context-1" }),
      call: firstCall,
      executionId: "capability-execution-1",
      intent: "Read the opaque current value.",
      controls: {},
      settledCapabilityResults: [],
    });
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(ledger.current()).toBe(settledHead);
    expect(ledger.current().state.capabilityExecutions).toEqual([
      expect.objectContaining({
        executionId: execution.executionId,
        callId: firstCall.callId,
        invocationAttempt: 1,
        capabilityId: "example.observe",
        status: "settled",
        outcome: "succeeded",
        observedEffect: "observation",
        summary: opaqueObservation,
      }),
    ]);
    expect(ledger.current().state.capabilityExecutions[0]).toMatchObject({
      intent: "Read the opaque current value.",
      controlsJson: "{}",
    });
    expect(secondCall).toMatchObject({
      callId: firstCall.callId,
      status: "active",
      activationCount: 2,
    });
  });

  test("logs a safe model error category without an adapter-controlled name", async () => {
    configureDebugLogger({ enabled: true });
    const errorSecret = "WORKER_MODEL_ERROR_NAME_MUST_NOT_BE_LOGGED";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ledger, call } = await openWorkerLedger();
    const binding = createBinding(ledger, call);
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
      const error = new TypeError("model invocation failed");
      error.name = errorSecret;
      throw error;
    });

    await expect(
      runWorkerDecision(createRequest(invoke), {
        call,
        requestToolResults: EMPTY_REQUEST_TOOL_RESULTS,
        capabilitySource: capabilitySource(ledger, binding),
      }),
    ).rejects.toThrow("model invocation failed");
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.worker",
          event: "model.failed",
          errorType: "TypeError",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(errorSecret);
  });
});
