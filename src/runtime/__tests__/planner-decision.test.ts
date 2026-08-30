import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ModelGatewayClient } from "../ports.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import type { RequestToolResultsView } from "../context/request-tool-results.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  requireRoleCallChildReturnCommit,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
  type RoleCallChildReturnCommit,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  buildPlannerDecisionInput,
  createPlannerDecisionFormat,
  GENERIC_PLANNER_EXECUTOR,
  parsePlannerDecisionOutput,
  PLANNER_DECISION_MODEL_STEP,
  PLANNER_OBJECTIVE_MAX_LENGTH,
  PLANNER_RESULT_MAX_LENGTH,
  projectPlannerDecisionCallIdentity,
  runPlannerDecision,
} from "../steps/planner-decision/index.js";

const runnerConfig: RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: "runtime-default",
      steps: {
        [PLANNER_DECISION_MODEL_STEP]: "planner.decision",
      },
    },
  },
  context: {
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
  steps: {
    [PLANNER_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
  } as RequestRunnerConfig["steps"],
};

const modelPolicy = {
  providers: { local: { type: "ollama" as const } },
  profiles: {
    "runtime-default": {
      provider: "local",
      model: "runtime-default:latest",
      contextWindowTokens: 32_000,
      supportsThinking: true,
      calibration: {
        "planner.decision": {},
      },
    },
  },
  defaults: {
    profileId: "runtime-default",
    steps: {
      [PLANNER_DECISION_MODEL_STEP]: "planner.decision",
    },
  },
};

const plannerCall: RoleCallFrame = Object.freeze({
  callId: "call-2",
  parentCallId: "call-1",
  roleId: "planner",
  depth: 1,
  objective: "Prepare a short research summary and save it.",
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
const REQUEST_TOOL_RESULT_SUMMARY =
  "The canonical request-wide observation is available.";
const REQUEST_SOURCE_PROMPT =
  "Create /tmp/exact target.txt with EXACT_LITERAL_42.\nPreserve spaces.";

function testExactCapabilityResult(
  input: Readonly<{
    outcome: "succeeded" | "failed";
    observedEffect: "none" | "observation" | "mutation" | "indeterminate";
    summary: string;
  }>,
) {
  return Object.freeze({
    kind: "generic_capability_result_v1" as const,
    authority: "capability_adapter" as const,
    status: "executed" as const,
    ok: input.outcome === "succeeded",
    payload: Object.freeze({ ...input }),
  });
}
const AVAILABLE_WORKER_CAPABILITY_CATALOG = Object.freeze([
  Object.freeze({
    groupId: "documents",
    memberCount: 2,
    effects: Object.freeze(["observation", "mutation"] as const),
  }),
  Object.freeze({
    groupId: "read",
    memberCount: 1,
    effects: Object.freeze(["observation"] as const),
  }),
  Object.freeze({
    groupId: "write",
    memberCount: 1,
    effects: Object.freeze(["mutation"] as const),
  }),
]);
const WORKER_CAPABILITY_SCOPE = Object.freeze({
  catalogGroupIds: Object.freeze(["documents"]),
});
const WORKING_DIRECTORY = "projects/planner-bounded-artifact";
const scopedPlannerCall: RoleCallFrame = Object.freeze({
  ...plannerCall,
  workingDirectory: WORKING_DIRECTORY,
});

function decisionText(decision: Record<string, unknown>): string {
  return JSON.stringify({ decision });
}

function decisionVariants(
  schema: Record<string, unknown>,
): Record<string, unknown>[] {
  const decision = (
    schema as {
      properties: {
        decision: Record<string, unknown> & {
          anyOf?: Record<string, unknown>[];
        };
      };
    }
  ).properties.decision;
  return decision.anyOf ?? [decision];
}

function createRequest(
  invoke: ModelGatewayClient["invoke"] = vi.fn(async () => ({
    text: decisionText({
      action: "invoke_role",
      roleId: "worker",
      objective:
        "Produce the bounded artifact and report observable completion evidence.",
      workingDirectory: WORKING_DIRECTORY,
      workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
    }),
    meta: {},
  })),
): RequestExecutionScope {
  return createTestRequestExecutionScope({
    requestId: "planner-request",
    sessionId: "planner-session",
    prompt: REQUEST_SOURCE_PROMPT,
    historyMessages: [
      {
        id: "history-secret",
        role: "user",
        content: "HISTORY_MUST_NOT_REACH_PLANNER",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
    ],
    shouldGenerateSessionTitle: false,
    runnerConfig,
    attachments: [
      {
        id: "attachment-secret",
        kind: "image",
        name: "ATTACHMENT_MUST_NOT_REACH_PLANNER",
        mimeType: "image/png",
        storageRef: "attachments/ATTACHMENT_MUST_NOT_REACH_PLANNER",
        data: "ATTACHMENT_MUST_NOT_REACH_PLANNER",
      },
    ],
    agentMode: "reasoning",
    modelPolicy,
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () =>
        Object.freeze([
          Object.freeze({
            capabilityId: "test.document_read",
            summary: "Read one document.",
            effect: "observation" as const,
            controls: Object.freeze({
              type: "object" as const,
              additionalProperties: false as const,
              properties: Object.freeze({}),
              required: Object.freeze([]),
            }),
            catalogGroups: Object.freeze(["documents", "read"]),
          }),
          Object.freeze({
            capabilityId: "test.document_write",
            summary: "Write one document.",
            effect: "mutation" as const,
            controls: Object.freeze({
              type: "object" as const,
              additionalProperties: false as const,
              properties: Object.freeze({}),
              required: Object.freeze([]),
            }),
            catalogGroups: Object.freeze(["documents", "write"]),
          }),
        ]),
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

async function createReturnedPlannerChild(
  options: Readonly<{
    includePendingItem?: boolean;
    includeToolResult?: boolean;
  }> = {},
): Promise<{
  ledger: RoleCallLedger;
  commit: RoleCallChildReturnCommit;
  call: RoleCallFrame;
  childSummary: string;
}> {
  const ledger = createRoleCallLedger({
    requestId: "planner-request",
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
  await commitLedger(ledger, {
    authority: "runtime",
    type: "create_root",
  });
  await commitLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: plannerCall.objective!,
  });
  await commitLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-2",
    roleId: "worker",
    objective:
      "Produce the bounded artifact and report observable completion evidence.",
    workingDirectory: WORKING_DIRECTORY,
    workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
    plannerPlan: {
      mode: "declare",
      plan: {
        summary: plannerCall.objective!,
        items: [
          {
            title: "Produce bounded artifact",
            objective:
              "Produce the bounded artifact and report observable completion evidence.",
          },
          ...(options.includePendingItem === false
            ? []
            : [
                {
                  title: "Perform remaining mutation",
                  objective: "Perform only the remaining external mutation.",
                },
              ]),
        ],
      },
      selectedItemIndexes: [0],
    },
  });
  if (options.includeToolResult === true) {
    const begun = await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-3",
        invocationAttempt: 1,
        capabilityId: "test.observe",
        declaredEffect: "observation",
        intent: "Observe the requested tool result.",
        controlsJson: "{}",
      },
    });
    if (!begun.ok || begun.effect.type !== "capability_execution_begun") {
      throw new Error("planner fixture capability begin failed");
    }
    await commitLedger(ledger, {
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-3",
      executionId: begun.effect.executionId,
      outcome: "succeeded",
      observedEffect: "observation",
      summary: REQUEST_TOOL_RESULT_SUMMARY,
      exactResult: testExactCapabilityResult({
        outcome: "succeeded",
        observedEffect: "observation",
        summary: REQUEST_TOOL_RESULT_SUMMARY,
      }),
    });
  }
  const childSummary =
    "CHILD_RESULT_SECRET: artifact created and exact content verified.";
  const returned = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-2",
      childCallId: "call-3",
      outcome: "completed",
      summary: childSummary,
    },
  });
  if (!returned.ok) throw new Error(returned.code);
  const call = returned.head.state.calls.find(
    (candidate) => candidate.callId === returned.head.state.activeCallId,
  );
  if (!call) throw new Error("resumed Planner call missing");
  return {
    ledger,
    commit: requireRoleCallChildReturnCommit(returned),
    call,
    childSummary,
  };
}

async function createActivePlanner(workingDirectory?: string): Promise<{
  ledger: RoleCallLedger;
  call: RoleCallFrame;
}> {
  const ledger = createRoleCallLedger({
    requestId: "planner-request",
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
  await commitLedger(ledger, {
    authority: "runtime",
    type: "create_root",
  });
  const head = await commitLedger(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: plannerCall.objective!,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
  });
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("active Planner call missing");
  return { ledger, call };
}

async function commitLedger(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("generic Planner decision contract", () => {
  test("keeps Planner input at baseline when stored artifact paths exist", () => {
    const requestWithPaths = Object.freeze({
      ...createRequest(),
      sessionArtifactPaths: Object.freeze(["news/news.txt"]),
    });
    const unscoped = buildPlannerDecisionInput(requestWithPaths, {
      call: plannerCall,
      availableChildRoleIds: ["worker"],
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
    });
    const unscopedBaseline = buildPlannerDecisionInput(createRequest(), {
      call: plannerCall,
      availableChildRoleIds: ["worker"],
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
    });
    expect(unscoped.context.messages).toEqual(
      unscopedBaseline.context.messages,
    );
    expect(unscoped.format).toEqual(unscopedBaseline.format);

    const scopedWithPaths = buildPlannerDecisionInput(requestWithPaths, {
      call: scopedPlannerCall,
      availableChildRoleIds: ["worker"],
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
    });
    const scopedBaseline = buildPlannerDecisionInput(createRequest(), {
      call: scopedPlannerCall,
      availableChildRoleIds: ["worker"],
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
    });
    expect(scopedWithPaths.context.messages).toEqual(
      scopedBaseline.context.messages,
    );
    expect(scopedWithPaths.format).toEqual(scopedBaseline.format);
  });

  test("publishes exact terminal and available-child schemas", () => {
    expect(
      createPlannerDecisionFormat({
        availableChildRoleIds: ["worker", "researcher"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      }),
    ).toMatchObject({
      type: "json_schema",
      name: "planner_decision",
      strict: true,
      schema: {
        type: "object",
        required: ["decision"],
        additionalProperties: false,
        properties: {
          decision: {
            anyOf: [
              {
                properties: {
                  action: { enum: ["return_result"] },
                  result: { maxLength: PLANNER_RESULT_MAX_LENGTH },
                },
                required: ["action", "result"],
                additionalProperties: false,
              },
              {
                properties: {
                  action: { enum: ["return_failure"] },
                  reason: { maxLength: PLANNER_RESULT_MAX_LENGTH },
                },
                required: ["action", "reason"],
                additionalProperties: false,
              },
              {
                properties: {
                  action: { enum: ["invoke_role"] },
                  roleId: { enum: ["worker"] },
                  workingDirectory: {
                    maxLength: ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
                  },
                  objective: { maxLength: PLANNER_OBJECTIVE_MAX_LENGTH },
                  workerCapabilityScope: {
                    properties: {
                      catalogGroupIds: {
                        minItems: 1,
                        maxItems: 3,
                        items: {
                          enum: ["documents", "read", "write"],
                        },
                      },
                    },
                    required: ["catalogGroupIds"],
                    additionalProperties: false,
                  },
                },
                required: [
                  "action",
                  "roleId",
                  "workingDirectory",
                  "workerCapabilityScope",
                  "objective",
                ],
                additionalProperties: false,
              },
              {
                properties: {
                  action: { enum: ["invoke_role"] },
                  roleId: { enum: ["researcher"] },
                  objective: { maxLength: PLANNER_OBJECTIVE_MAX_LENGTH },
                },
                required: ["action", "roleId", "objective"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
    });
    expect(
      decisionVariants(
        createPlannerDecisionFormat({ availableChildRoleIds: [] })
          .schema as Record<string, unknown>,
      ),
    ).toHaveLength(2);
  });

  test("keeps the Worker catalog-group schema within the canonical scope limit", () => {
    const catalog = Object.freeze(
      Array.from({ length: 65 }, (_, index) =>
        Object.freeze({
          groupId: `group-${index}`,
          memberCount: 1,
          effects: Object.freeze(["observation"] as const),
        }),
      ),
    );
    const workerVariant = decisionVariants(
      createPlannerDecisionFormat({
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: catalog,
      }).schema as Record<string, unknown>,
    ).find(
      (variant) =>
        (
          variant as {
            properties?: { workerCapabilityScope?: unknown };
          }
        ).properties?.workerCapabilityScope !== undefined,
    ) as {
      properties: {
        workerCapabilityScope: {
          properties: { catalogGroupIds: { maxItems: number } };
        };
      };
    };

    expect(
      workerVariant.properties.workerCapabilityScope.properties.catalogGroupIds
        .maxItems,
    ).toBe(64);
  });

  test("post-validates the Worker working-directory bound only on its invoke variant", () => {
    const format = createPlannerDecisionFormat({
      availableChildRoleIds: ["worker", "researcher"],
      availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
    });

    expect(
      format.postValidatedSchemaConstraints?.filter(({ path }) =>
        path.includes("workingDirectory"),
      ),
    ).toEqual([
      {
        keyword: "maxLength",
        path: "/properties/decision/anyOf/2/properties/workingDirectory/maxLength",
      },
    ]);
  });

  test("omits one inherited runtime-owned working directory from the Worker model schema", () => {
    const format = createPlannerDecisionFormat({
      availableChildRoleIds: ["worker", "researcher"],
      availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      inheritedWorkingDirectory: WORKING_DIRECTORY,
    });
    const workerVariant = decisionVariants(
      format.schema as Record<string, unknown>,
    ).find(
      (variant) =>
        (
          variant as {
            properties?: { roleId?: { enum?: string[] } };
          }
        ).properties?.roleId?.enum?.includes("worker") === true,
    ) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(workerVariant.properties).not.toHaveProperty("workingDirectory");
    expect(workerVariant.required).not.toContain("workingDirectory");
    expect(
      format.postValidatedSchemaConstraints?.some(({ path }) =>
        path.includes("workingDirectory"),
      ),
    ).toBe(false);
    expect(() =>
      createPlannerDecisionFormat({
        availableChildRoleIds: ["worker"],
        inheritedWorkingDirectory: " ./project\\site ",
      }),
    ).toThrow("planner_inherited_working_directory_invalid");
  });

  test("parses and freezes exact Planner decisions", () => {
    const invoke = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: "  projects\\demo//./src  ",
        objective: "  Produce the requested bounded artifact.  ",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      {
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      },
    );
    const result = parsePlannerDecisionOutput(
      decisionText({
        action: "return_result",
        result: "  The complete bounded outcome.  ",
      }),
    );

    expect(invoke).toEqual({
      ok: true,
      decision: {
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: "projects/demo/src",
        objective: "Produce the requested bounded artifact.",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      },
    });
    expect(result).toEqual({
      ok: true,
      decision: {
        action: "return_result",
        result: "The complete bounded outcome.",
      },
    });
    if (invoke.ok) expect(Object.isFrozen(invoke.decision)).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.decision)).toBe(true);
  });

  test("mechanically merges inherited workingDirectory and rejects model echo or rewrite", () => {
    const parseOptions = {
      availableChildRoleIds: ["worker"] as const,
      availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      inheritedWorkingDirectory: WORKING_DIRECTORY,
    };
    const inherited = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        objective: "Produce the requested bounded artifact.",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      parseOptions,
    );
    const echoed = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        objective: "Produce the requested bounded artifact.",
        workingDirectory: WORKING_DIRECTORY,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      parseOptions,
    );
    const rewritten = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        objective: "Produce the requested bounded artifact.",
        workingDirectory: "another/project",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      parseOptions,
    );

    expect(inherited).toEqual({
      ok: true,
      decision: {
        action: "invoke_role",
        roleId: "worker",
        objective: "Produce the requested bounded artifact.",
        workingDirectory: WORKING_DIRECTORY,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      },
    });
    for (const rejected of [echoed, rewritten]) {
      expect(rejected).toMatchObject({
        ok: false,
        stage: "domain_parser",
        issues: [
          expect.objectContaining({
            code: "planner_decision_shape_invalid",
            path: "decision",
          }),
        ],
      });
    }
    expect(() =>
      parsePlannerDecisionOutput(
        decisionText({ action: "return_failure", reason: "Not available." }),
        { inheritedWorkingDirectory: " ./project\\site " },
      ),
    ).toThrow("planner_inherited_working_directory_invalid");
  });

  test("requires one valid non-empty scope only for Worker invocations", () => {
    const missing = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: "Produce the bounded artifact.",
      }),
      {
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      },
    );
    const unknown = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: "Produce the bounded artifact.",
        workerCapabilityScope: { catalogGroupIds: ["unknown"] },
      }),
      {
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      },
    );
    const nonWorker = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "researcher",
        objective: "Analyze the bounded source data.",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      { availableChildRoleIds: ["researcher"] },
    );
    const emptyCatalog = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: "Return the bounded knowledge result.",
      }),
      { availableChildRoleIds: ["worker"] },
    );
    const emptyCatalogWithScope = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: "Return the bounded knowledge result.",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      { availableChildRoleIds: ["worker"] },
    );

    expect(missing).toMatchObject({ ok: false, stage: "domain_parser" });
    if (!missing.ok) {
      expect(missing.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "planner_worker_capability_scope_invalid",
            path: "decision.workerCapabilityScope.catalogGroupIds",
          }),
        ]),
      );
    }
    expect(unknown).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "planner_worker_capability_scope_invalid",
          path: "decision.workerCapabilityScope.catalogGroupIds",
        }),
      ],
    });
    expect(nonWorker).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "planner_decision_shape_invalid",
          path: "decision",
        }),
      ],
    });
    expect(emptyCatalog).toEqual({
      ok: true,
      decision: {
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: "Return the bounded knowledge result.",
      },
    });
    expect(emptyCatalogWithScope).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "planner_decision_shape_invalid",
          path: "decision",
        }),
      ],
    });
  });

  test("requires and canonically normalizes Worker workingDirectory only", () => {
    const missing = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        objective: "Produce the bounded artifact.",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      {
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      },
    );
    const invalid = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: "../outside",
        objective: "Produce the bounded artifact.",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      {
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      },
    );
    const tooLong = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: "x".repeat(
          ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH + 1,
        ),
        objective: "Produce the bounded artifact.",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      {
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      },
    );
    const root = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: ".",
        objective: "Produce the bounded artifact.",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      {
        availableChildRoleIds: ["worker"],
        availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      },
    );
    const nonWorker = parsePlannerDecisionOutput(
      decisionText({
        action: "invoke_role",
        roleId: "researcher",
        workingDirectory: WORKING_DIRECTORY,
        objective: "Analyze the bounded source data.",
      }),
      { availableChildRoleIds: ["researcher"] },
    );

    expect(missing).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "planner_decision_shape_invalid",
          path: "decision",
        }),
      ],
    });
    expect(invalid).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "planner_working_directory_invalid",
          path: "decision.workingDirectory",
        }),
      ],
    });
    expect(root).toMatchObject({
      ok: true,
      decision: { workingDirectory: "." },
    });
    expect(tooLong).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "planner_working_directory_invalid",
          path: "decision.workingDirectory",
        }),
      ],
    });
    expect(nonWorker).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "planner_decision_shape_invalid",
          path: "decision",
        }),
      ],
    });
  });

  test("keeps dependency transport out of the Planner model contract", () => {
    const format = createPlannerDecisionFormat({
      availableChildRoleIds: ["worker"],
      availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
    });
    const invokeVariant = decisionVariants(
      format.schema as Record<string, unknown>,
    )[2] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(invokeVariant.required).toEqual([
      "action",
      "roleId",
      "workingDirectory",
      "workerCapabilityScope",
      "objective",
    ]);
    expect(invokeVariant.properties).not.toHaveProperty("dependencyResultRefs");

    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          objective: "Perform only the remaining external mutation.",
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
        }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
        },
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: "Perform only the remaining external mutation.",
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      },
    });
    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          objective: "Perform only the remaining external mutation.",
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
          dependencyResultRefs: ["result-1"],
        }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
        },
      ),
    ).toMatchObject({ ok: false, stage: "domain_parser" });
  });

  test("rejects invalid envelopes, unavailable roles, extra fields, and bad bounds", () => {
    expect(parsePlannerDecisionOutput("not-json")).toMatchObject({
      ok: false,
      stage: "json_envelope",
      issues: [{ code: "planner_output_not_json", path: "decision" }],
    });
    expect(
      parsePlannerDecisionOutput(
        JSON.stringify({ action: "return_result", result: "Done." }),
      ),
    ).toMatchObject({
      ok: false,
      stage: "json_envelope",
      issues: [{ code: "planner_output_envelope_invalid", path: "decision" }],
    });
    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "invoke_role",
          roleId: "reviewer",
          objective: "Review the outcome.",
        }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
        },
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          code: "planner_child_role_unavailable",
          path: "decision.roleId",
        },
      ],
    });
    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "return_result",
          result: "Valid result.",
          progress: "done",
        }),
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "planner_decision_shape_invalid", path: "decision" }],
    });
    expect(
      parsePlannerDecisionOutput(
        decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          objective: "x".repeat(PLANNER_OBJECTIVE_MAX_LENGTH + 1),
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
        }),
        {
          availableChildRoleIds: ["worker"],
          availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
        },
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        { code: "planner_objective_invalid", path: "decision.objective" },
      ],
    });
  });

  test("requires one active non-root Planner frame", () => {
    expect(projectPlannerDecisionCallIdentity(plannerCall)).toEqual({
      callId: "call-2",
      parentCallId: "call-1",
      depth: 1,
      invocationAttempt: 1,
    });
    expect(projectPlannerDecisionCallIdentity(scopedPlannerCall)).toEqual({
      callId: "call-2",
      parentCallId: "call-1",
      depth: 1,
      invocationAttempt: 1,
    });
    for (const invalid of [
      { ...plannerCall, roleId: "worker" as const },
      { ...plannerCall, parentCallId: null, depth: 0 },
      { ...plannerCall, status: "completed" as const },
      { ...plannerCall, objective: null },
      { ...plannerCall, activationCount: 0 },
      { ...plannerCall, resultRef: "result-1" },
      { ...plannerCall, workingDirectory: " ./project\\site " },
    ]) {
      expect(() => projectPlannerDecisionCallIdentity(invalid)).toThrow(
        "planner_call_frame_invalid",
      );
    }
  });

  test("rejects invalid available-role configuration before parsing", () => {
    expect(() =>
      createPlannerDecisionFormat({
        availableChildRoleIds: ["worker", "worker"],
      }),
    ).toThrow("planner_available_child_roles_invalid");
    expect(() =>
      parsePlannerDecisionOutput(
        decisionText({ action: "return_result", result: "Done." }),
        {
          availableChildRoleIds: ["supervisor" as never],
        },
      ),
    ).toThrow("planner_available_child_roles_invalid");
  });

  test("projects the exact request source before the exact Planner assignment", () => {
    configureDebugLogger({ enabled: true });
    const request = createRequest();
    const objective = "OBJECTIVE_SECRET_AVAILABLE_ONLY_IN_MODEL_CONTEXT";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = buildPlannerDecisionInput(request, {
      call: { ...plannerCall, objective },
      availableChildRoleIds: ["worker", "researcher"],
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
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
      sourceRef: "request:planner-request",
      currentRequest: REQUEST_SOURCE_PROMPT,
    });
    expect(assignment).toEqual({
      kind: "runtime_planner_assignment",
      callId: "call-2",
      parentCallId: "call-1",
      depth: 1,
      invocationAttempt: 1,
      objective,
      availableChildRoleIds: ["worker", "researcher"],
      availableWorkerCapabilityCatalog: AVAILABLE_WORKER_CAPABILITY_CATALOG,
      completedChildResultCount: 0,
    });
    const serializedContext = JSON.stringify(input.context);
    expect(serializedContext.match(/EXACT_LITERAL_42/g)).toHaveLength(1);
    expect(assignment.objective).toBe(objective);
    expect(serializedContext).not.toContain("HISTORY_MUST_NOT_REACH_PLANNER");
    expect(serializedContext).not.toContain(
      "ATTACHMENT_MUST_NOT_REACH_PLANNER",
    );
    expect(input.context.messages[0]!.content).toContain(
      "including required counts, requested format or structure, and scope",
    );
    expect(input.context.messages[0]!.content).toContain(
      "never add file listings, full artifact contents, tool transcripts, rereads, tests, or other verification as child deliverables",
    );
    expect(input.context.messages[0]!.content).toContain(
      "Worker is the only role that performs concrete external observation",
    );
    expect(input.context.messages[0]!.content).toContain(
      "Every child is an isolated call frame",
    );
    expect(input.context.messages[0]!.content).toContain(
      "runtime_role_call_assignment_scope_v1 as read-only continuity data",
    );
    expect(input.context.messages[0]!.content).not.toContain(
      "It never receives this Planner's objective",
    );
    expect(input.context.messages[0]!.content).toContain(
      "runtime_request_tool_results_v1 is request-wide read-only reference data",
    );
    expect(input.context.messages[0]!.content).toContain(
      "runtime_request_tool_results_v1 and dependencyResults are separate reference lanes",
    );
    expect(input.context.messages[0]!.content).toContain(
      "never ask it to assume, simulate, rediscover, or confirm unavailable work",
    );
    expect(input.context.messages[0]!.content).toContain(
      "Do not split one coherent bounded outcome without a material reason",
    );
    expect(input.context.messages[0]!.content).toContain(
      "supplied automatically by the runtime",
    );
    expect(input.context.messages[0]!.content).not.toContain("news.txt");
    expect(input.context.messages[0]!.content).not.toContain("favorite color");
    expect(serializedContext).not.toContain("development");
    expect(serializedContext).not.toContain("general");
    expect(serializedContext).not.toContain("test.document_read");
    expect(serializedContext).not.toContain("test.document_write");
    expect(serializedContext).not.toContain("Read one document.");
    expect(serializedContext).not.toContain("Write one document.");
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.planner",
          event: "context.projected",
          requestId: request.requestId,
          role: "planner",
          modelStep: PLANNER_DECISION_MODEL_STEP,
          callId: "call-2",
          parentCallId: "call-1",
          objectiveLength: objective.length,
          projectContextIncluded: false,
          plannedWorkContextIncluded: false,
          capabilityContextIncluded: true,
          workerCapabilityCatalogGroupCount: 3,
          workerCapabilityCatalogGroupIds: ["documents", "read", "write"],
          workerCapabilityCatalogMemberCount: 4,
          availableChildRoleIds: ["worker", "researcher"],
          completedChildResultCount: 0,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(objective);
  });

  test("projects inherited Planner scope while keeping it out of Worker output", () => {
    const input = buildPlannerDecisionInput(createRequest(), {
      call: scopedPlannerCall,
      availableChildRoleIds: ["worker", "reviewer"],
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
    });
    const assignment = JSON.parse(input.context.messages[2]!.content) as Record<
      string,
      unknown
    >;
    const workerVariant = decisionVariants(
      input.format.schema as Record<string, unknown>,
    ).find(
      (variant) =>
        (
          variant as {
            properties?: { roleId?: { enum?: string[] } };
          }
        ).properties?.roleId?.enum?.includes("worker") === true,
    ) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(input.inheritedWorkingDirectory).toBe(WORKING_DIRECTORY);
    expect(assignment).toMatchObject({
      kind: "runtime_planner_assignment",
      workingDirectory: WORKING_DIRECTORY,
    });
    expect(workerVariant.properties).not.toHaveProperty("workingDirectory");
    expect(workerVariant.required).not.toContain("workingDirectory");
    expect(input.context.messages[0]!.content).toContain(
      "The runtime supplies it mechanically; do not emit or replace workingDirectory",
    );
    expect(input.context.messages[0]!.content).not.toContain(
      "Every Worker invoke_role must include workingDirectory",
    );
  });

  test("offers unscoped Worker knowledge work when the catalog is empty", () => {
    const baseRequest = createRequest();
    const input = buildPlannerDecisionInput(
      {
        ...baseRequest,
        workerCapabilities: {
          ...baseRequest.workerCapabilities,
          provider: {
            getDescriptors: () => Object.freeze([]),
            getAdapters: () => Object.freeze([]),
          },
        },
      },
      {
        call: plannerCall,
        availableChildRoleIds: ["worker", "researcher"],
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
      },
    );
    const assignment = JSON.parse(input.context.messages[2]!.content) as Record<
      string,
      unknown
    >;

    expect(input.availableChildRoleIds).toEqual(["worker", "researcher"]);
    expect(input.availableWorkerCapabilityCatalog).toEqual([]);
    expect(assignment).toMatchObject({
      availableChildRoleIds: ["worker", "researcher"],
    });
    expect(assignment).not.toHaveProperty("availableWorkerCapabilityCatalog");
    const workerVariant = decisionVariants(
      input.format.schema as Record<string, unknown>,
    )[2] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(workerVariant.properties).toMatchObject({
      roleId: { enum: ["worker"] },
      workingDirectory: {
        maxLength: ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
      },
    });
    expect(workerVariant.properties).not.toHaveProperty(
      "workerCapabilityScope",
    );
    expect(workerVariant.required).toEqual([
      "action",
      "roleId",
      "workingDirectory",
      "objective",
    ]);
  });

  test("projects current target state instead of superseded tool attempts", () => {
    configureDebugLogger({ enabled: true });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = buildPlannerDecisionInput(createRequest(), {
      call: plannerCall,
      availableChildRoleIds: ["worker"],
      toolResults: Object.freeze({
        sourceRevision: 12,
        results: Object.freeze([
          Object.freeze({
            executionId: "failed-first",
            callId: "call-3",
            invocationAttempt: 1,
            capabilityId: "write_file",
            declaredEffect: "mutation",
            outcome: "failed",
            observedEffect: "none",
            summary: "The first write attempt failed.",
            references: Object.freeze([
              Object.freeze({
                kind: "tool_target" as const,
                target: "project/events.json",
              }),
            ]),
          }),
          Object.freeze({
            executionId: "successful-retry",
            callId: "call-4",
            invocationAttempt: 1,
            capabilityId: "write_file",
            declaredEffect: "mutation",
            outcome: "succeeded",
            observedEffect: "mutation",
            summary: "The retry created project/events.json.",
            references: Object.freeze([
              Object.freeze({
                kind: "tool_target" as const,
                target: "project/events.json",
              }),
            ]),
          }),
        ]),
      }),
    });
    const toolResults = input.context.messages
      .map(({ content }) => {
        try {
          return JSON.parse(content) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((message) => message?.kind === "runtime_request_tool_results_v1");
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(toolResults).toMatchObject({
      sourceRevision: 12,
      results: [
        expect.objectContaining({
          executionId: "successful-retry",
          outcome: "succeeded",
        }),
      ],
    });
    expect(JSON.stringify(toolResults)).not.toContain("failed-first");
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.planner",
          event: "context.projected",
          sourceToolResultCount: 2,
          projectedToolResultCount: 1,
          supersededToolResultCount: 1,
          retainedFailedToolResultCount: 0,
          retainedUntargetedToolResultCount: 0,
        }),
      ]),
    );
  });

  test("defers configured Markdown methodology to shared invocation with bounded diagnostics", () => {
    configureDebugLogger({ enabled: true });
    const methodology =
      "# TEST PLANNER METHODOLOGY\n\nDecompose by meaningful outcomes.";
    const methodologyRef = "./methodologies/test-planner.md";
    const methodologyHash = "test-planner-methodology-hash";
    const baseRequest = createRequest();
    const request = {
      ...baseRequest,
      runnerConfig: {
        ...baseRequest.runnerConfig,
        steps: {
          ...baseRequest.runnerConfig.steps,
          [PLANNER_DECISION_MODEL_STEP]: {
            timeoutMs: 20_000,
            instructionBlocks: [
              {
                ref: methodologyRef,
                content: methodology,
                contentHash: methodologyHash,
              },
            ],
          },
        },
      },
    };
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = buildPlannerDecisionInput(request, {
      call: plannerCall,
      availableChildRoleIds: ["worker"],
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
    });
    const instructions = input.context.messages[0]!.content;
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(instructions).toContain(
      "You are the Planner for exactly one bounded role call",
    );
    expect(instructions).not.toContain(methodology);
    expect(instructions).not.toContain(methodologyRef);
    expect(instructions).not.toContain(methodologyHash);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.planner",
          event: "context.projected",
          configuredInstructionBlockCount: 1,
          configuredInstructionCharacterCount: methodology.length,
          configuredInstructionRefs: [methodologyRef],
          configuredInstructionContentHashes: [methodologyHash],
        }),
      ]),
    );
  });

  test("projects a returned child from the exact canonical commit", async () => {
    configureDebugLogger({ enabled: true });
    const { ledger, commit, call, childSummary } =
      await createReturnedPlannerChild();
    const request = createRequest();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const input = buildPlannerDecisionInput(request, {
      call,
      availableChildRoleIds: ["worker", "reviewer"],
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
      progress: { kind: "role_child", ledger, commit },
    });
    const source = JSON.parse(input.context.messages[1]!.content) as Record<
      string,
      unknown
    >;
    const assignment = JSON.parse(input.context.messages[2]!.content) as Record<
      string,
      unknown
    >;
    const invocation = JSON.parse(input.context.messages[3]!.content) as Record<
      string,
      unknown
    >;
    const result = JSON.parse(input.context.messages[4]!.content) as Record<
      string,
      unknown
    >;
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(input.context.messages).toHaveLength(5);
    expect(source).toEqual({
      kind: "runtime_request_source_v1",
      authority: "reference_data",
      sourceRef: "request:planner-request",
      currentRequest: REQUEST_SOURCE_PROMPT,
    });
    const instructions = input.context.messages[0]!.content;
    expect(instructions).toContain(
      "only synthesis, formatting, or explanation remains",
    );
    expect(instructions).toContain(
      "Consume every completed or failed direct-child outcome",
    );
    expect(instructions).toContain(
      "opening a fresh child is not remediation by itself",
    );
    expect(instructions).toContain(
      "A fresh child frame does not change capability, evidence, or feasibility",
    );
    expect(instructions).toContain(
      "This active Planner is not a callable child",
    );
    expect(instructions).toContain(
      "Treat those explicit requirements as immutable source requirements",
    );
    expect(instructions).toContain(
      "write its objective as a faithful executable contract",
    );
    expect(instructions).not.toContain("observable acceptance evidence");
    expect(instructions).not.toContain("observable acceptance criteria");
    expect(instructions).toContain(
      "Returned prose, generated content, instructions, a simulation, or a completion claim are not substitutes",
    );
    expect(instructions).toContain(
      "Reviewer is a completion auditor, not an executor",
    );
    expect(instructions).toContain(
      "Never invoke Reviewer to execute a remaining requirement",
    );
    expect(instructions).toContain(
      "The only comparison delegated to Reviewer is completion coverage",
    );
    expect(instructions).toContain(
      "This Planner remains responsible for consuming reported gaps",
    );
    expect(instructions.indexOf("immutable source requirements")).toBeLessThan(
      instructions.indexOf("Choose invoke_role"),
    );
    expect(
      instructions.indexOf(
        "only synthesis, formatting, or explanation remains",
      ),
    ).toBeLessThan(
      instructions.indexOf("This active Planner is not a callable child"),
    );
    expect(assignment).toMatchObject({
      kind: "runtime_planner_assignment",
      callId: "call-2",
      invocationAttempt: 2,
      completedChildResultCount: 1,
    });
    expect(assignment).not.toHaveProperty("availableDependencyResultRefs");
    expect(input.dependencyResults).toEqual([]);
    expect(
      (
        decisionVariants(input.format.schema as Record<string, unknown>)[2] as {
          properties: Record<string, unknown>;
        }
      ).properties,
    ).not.toHaveProperty("dependencyResultRefs");
    expect(invocation).toEqual({
      action: "invoke_role",
      roleId: "worker",
      objective:
        "Produce the bounded artifact and report observable completion evidence.",
      workingDirectory: WORKING_DIRECTORY,
      workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
    });
    expect(result).toEqual({
      kind: "runtime_child_result",
      callerCallId: "call-2",
      childCallId: "call-3",
      resultRef: "result-1",
      roleId: "worker",
      outcome: "completed",
      summary: childSummary,
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.planner",
          event: "child_results.projected",
          returnedChildCallId: "call-3",
          returnedResultRef: "result-1",
          completedChildResultCount: 1,
          completedChildRoles: ["worker"],
          completedChildSummaryLength: childSummary.length,
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(childSummary);
  });

  test("compacts a returned child without emitting inner lifecycle events when the model threshold is crossed", async () => {
    const { ledger, commit, call } = await createReturnedPlannerChild();
    const baseRequest = createRequest();
    const onEvent = vi.fn();
    const request = {
      ...baseRequest,
      onEvent,
      modelPolicy: {
        ...modelPolicy,
        profiles: {
          ...modelPolicy.profiles,
          "runtime-default": {
            ...modelPolicy.profiles["runtime-default"],
            contextWindowTokens: 7_685,
          },
        },
      },
    };
    const input = buildPlannerDecisionInput(request, {
      call,
      availableChildRoleIds: ["worker", "reviewer"],
      toolResults: EMPTY_REQUEST_TOOL_RESULTS,
      progress: { kind: "role_child", ledger, commit },
    });
    const parsedMessages = input.context.messages.flatMap((message) => {
      try {
        return [JSON.parse(message.content) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

    expect(input.context.budget.estimatedInputTokens).toBeLessThan(
      input.context.budget.compactionTriggerInputTokens,
    );
    expect(input.context.compaction.applied).toBe(true);
    expect(input.context.messages).toHaveLength(4);
    expect(
      parsedMessages.filter((message) => message.action === "invoke_role"),
    ).toHaveLength(0);
    expect(
      parsedMessages.find((message) => message.kind === "runtime_child_result"),
    ).toMatchObject({
      resultRef: "result-1",
      delegatedObjective:
        "Produce the bounded artifact and report observable completion evidence.",
      dependencyResultRefs: [],
      outcome: "completed",
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("rejects stale and non-canonical child continuation sources", async () => {
    const { ledger, commit, call } = await createReturnedPlannerChild();
    const request = createRequest();
    await commitLedger(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "reviewer",
      objective: "Perform only the remaining external mutation.",
      plannerPlan: {
        mode: "select",
        itemIds: ["plan-call-2-item-2"],
      },
    });
    expect(() =>
      buildPlannerDecisionInput(request, {
        call,
        availableChildRoleIds: ["worker", "reviewer"],
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
        progress: { kind: "role_child", ledger, commit },
      }),
    ).toThrow("role_child_return_commit_invalid");

    const fresh = await createReturnedPlannerChild();
    expect(() =>
      buildPlannerDecisionInput(request, {
        call: { ...fresh.call },
        availableChildRoleIds: ["worker"],
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
        progress: {
          kind: "role_child",
          ledger: fresh.ledger,
          commit: fresh.commit,
        },
      }),
    ).toThrow("planner_child_resume_source_mismatch");
  });

  test("invokes one structured Planner step and logs no decision content", async () => {
    configureDebugLogger({ enabled: true });
    const delegatedObjective =
      "DELEGATED_OBJECTIVE_SECRET: produce the bounded artifact.";
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        objective: delegatedObjective,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      }),
      meta: {},
    }));
    const request = createRequest(invoke);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runPlannerDecision(request, {
        call: plannerCall,
        availableChildRoleIds: ["worker"],
        toolResults: EMPTY_REQUEST_TOOL_RESULTS,
      }),
    ).resolves.toEqual({
      action: "invoke_role",
      roleId: "worker",
      workingDirectory: WORKING_DIRECTORY,
      objective: delegatedObjective,
      workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
    });
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        modelStep: PLANNER_DECISION_MODEL_STEP,
        debugRequestId: request.requestId,
        format: expect.objectContaining({
          type: "json_schema",
          name: "planner_decision",
          strict: true,
        }),
        messages: expect.any(Array),
      }),
    );
    expect(request.onThinkingTrace).toHaveBeenCalledWith({
      step: PLANNER_DECISION_MODEL_STEP,
      status: "completed",
      text: "",
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.planner",
          event: "output.envelope.accepted",
          validationStage: "json_envelope",
        }),
        expect.objectContaining({
          scope: "runtime.planner",
          event: "decision.accepted",
          validationStage: "domain_parser",
          selectedAction: "invoke_role",
          childRoleId: "worker",
          childObjectiveLength: delegatedObjective.length,
          workingDirectoryIncluded: true,
          workingDirectoryLength: WORKING_DIRECTORY.length,
          workerCapabilityScopeGroupCount: 1,
          workerCapabilityScopeGroupIds: ["documents"],
        }),
        expect.objectContaining({
          scope: "runtime.planner",
          event: "model.completed",
          mappedOutcome: "child_role_requested",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(delegatedObjective);
    expect(JSON.stringify(logs)).not.toContain(WORKING_DIRECTORY);
  });

  test("inherits Planner workingDirectory into one Worker handoff without model ownership", async () => {
    configureDebugLogger({ enabled: true });
    const delegatedObjective =
      "Create the requested bounded artifact inside the inherited project.";
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const workerVariant = decisionVariants(
        (input.format as { schema: Record<string, unknown> }).schema,
      ).find(
        (variant) =>
          (
            variant as {
              properties?: { roleId?: { enum?: string[] } };
            }
          ).properties?.roleId?.enum?.includes("worker") === true,
      ) as {
        properties: Record<string, unknown>;
        required: string[];
      };
      const assignment = (input.messages as readonly { content: string }[])
        .map(({ content }) => {
          try {
            return JSON.parse(content) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })
        .find((message) => message?.kind === "runtime_planner_assignment");

      expect(workerVariant.properties).not.toHaveProperty("workingDirectory");
      expect(workerVariant.required).not.toContain("workingDirectory");
      expect(assignment).toMatchObject({
        workingDirectory: WORKING_DIRECTORY,
      });
      return {
        text: decisionText({
          action: "invoke_role",
          roleId: "worker",
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
          plan: {
            summary: "Create the requested bounded project artifact.",
            items: [
              {
                title: "Create bounded artifact",
                objective: delegatedObjective,
              },
            ],
          },
          selectedItemIndexes: [0],
        }),
        meta: {},
      };
    });
    const request = createRequest(invoke);
    const { ledger, call } = await createActivePlanner(WORKING_DIRECTORY);
    const head = ledger.current();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      GENERIC_PLANNER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: ["worker"],
      }),
    ).resolves.toEqual({
      kind: "invoke_role",
      roleId: "worker",
      objective: delegatedObjective,
      workingDirectory: WORKING_DIRECTORY,
      workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Create the requested bounded project artifact.",
          items: [
            {
              title: "Create bounded artifact",
              objective: delegatedObjective,
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });
    expect(ledger.current()).toBe(head);
    const logs = consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.planner",
          event: "context.projected",
          workingDirectoryInherited: true,
          workingDirectoryIncluded: true,
          workingDirectoryLength: WORKING_DIRECTORY.length,
        }),
        expect.objectContaining({
          scope: "runtime.planner",
          event: "decision.accepted",
          workingDirectorySource: "inherited",
        }),
        expect.objectContaining({
          scope: "runtime.planner",
          event: "model.completed",
          workingDirectorySource: "inherited",
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(WORKING_DIRECTORY);
  });

  test("maps one initial Planner activation to a child-role request", async () => {
    const delegatedObjective =
      "Create the requested bounded artifact and report exact evidence.";
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: decisionText({
        action: "invoke_role",
        roleId: "worker",
        workingDirectory: WORKING_DIRECTORY,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
        plan: {
          summary: "Create and verify the requested bounded artifact.",
          items: [
            {
              title: "Create bounded artifact",
              objective: delegatedObjective,
            },
          ],
        },
        selectedItemIndexes: [0],
      }),
      meta: {},
    }));
    const request = createRequest(invoke);
    const { ledger, call } = await createActivePlanner();
    const head = ledger.current();

    await expect(
      GENERIC_PLANNER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: ["worker"],
      }),
    ).resolves.toEqual({
      kind: "invoke_role",
      roleId: "worker",
      workingDirectory: WORKING_DIRECTORY,
      objective: delegatedObjective,
      workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Create and verify the requested bounded artifact.",
          items: [
            {
              title: "Create bounded artifact",
              objective: delegatedObjective,
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });
    expect(ledger.current()).toBe(head);
    expect(
      vi
        .mocked(request.onEvent)
        .mock.calls.filter(([name]) => name === "runtime.state"),
    ).toEqual([
      [
        "runtime.state",
        {
          stage: "planner",
          phase: "planning",
          message: "Planning the delegated work...",
        },
      ],
    ]);
  });

  test("maps a truthful Planner failure without changing ledger state", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: decisionText({
        action: "return_failure",
        reason: "The required evidence is unavailable.",
      }),
      meta: {},
    }));
    const request = createRequest(invoke);
    const { ledger, call } = await createActivePlanner();
    const head = ledger.current();

    await expect(
      GENERIC_PLANNER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: ["worker"],
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "failed",
      summary: "The required evidence is unavailable.",
    });
    expect(ledger.current()).toBe(head);
  });

  test("rejects a capability continuation before invoking Planner", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>();
    const request = createRequest(invoke);
    const { ledger, call } = await createActivePlanner();

    await expect(
      GENERIC_PLANNER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: ["worker"],
        continuation: {
          kind: "capability_execution",
          executionId: "capability-execution-1",
        },
      }),
    ).rejects.toThrow("planner_capability_continuation_unsupported");
    expect(invoke).not.toHaveBeenCalled();
    expect(request.onEvent).not.toHaveBeenCalled();
  });

  test("maps the next canonical plan item without model-managed dependencies", async () => {
    const { ledger, commit, call } = await createReturnedPlannerChild();
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      expect(messages).toHaveLength(4);
      expect(JSON.parse(messages[1]!.content)).toEqual({
        kind: "runtime_request_source_v1",
        authority: "reference_data",
        sourceRef: "request:planner-request",
        currentRequest: REQUEST_SOURCE_PROMPT,
      });
      expect(messages[3]).toMatchObject({ role: "user" });
      expect(JSON.parse(messages[3]!.content)).toEqual({
        kind: "runtime_child_result",
        callerCallId: "call-2",
        childCallId: "call-3",
        resultRef: "result-1",
        roleId: "worker",
        delegatedObjective:
          "Produce the bounded artifact and report observable completion evidence.",
        workingDirectory: WORKING_DIRECTORY,
        workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
        dependencyResultRefs: [],
        outcome: "completed",
        summary:
          "CHILD_RESULT_SECRET: artifact created and exact content verified.",
      });
      expect(
        messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.includes('"objective"'),
        ),
      ).toBe(false);
      return {
        text: decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
          planItemIds: ["plan-call-2-item-2"],
        }),
        meta: {},
      };
    });

    await expect(
      GENERIC_PLANNER_EXECUTOR.execute({
        context: createRequest(invoke),
        call,
        ledger,
        availableChildRoleIds: ["worker"],
        continuation: {
          kind: "role_child",
          commit,
        },
      }),
    ).resolves.toEqual({
      kind: "invoke_role",
      roleId: "worker",
      workingDirectory: WORKING_DIRECTORY,
      objective: "Perform only the remaining external mutation.",
      workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      plannerPlan: {
        mode: "select",
        itemIds: ["plan-call-2-item-2"],
      },
    });
  });

  test("maps explicit newly established work to one canonical plan extension", async () => {
    const { ledger } = await createReturnedPlannerChild();
    await commitLedger(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      workingDirectory: WORKING_DIRECTORY,
      objective: "Perform only the remaining external mutation.",
      workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      dependencyResultRefs: ["result-1"],
      plannerPlan: {
        mode: "select",
        itemIds: ["plan-call-2-item-2"],
      },
    });
    const returned = await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-2",
        childCallId: "call-4",
        outcome: "completed",
        summary: "The remaining external mutation is complete.",
      },
    });
    if (!returned.ok) throw new Error(returned.code);
    const commit = requireRoleCallChildReturnCommit(returned);
    const call = returned.head.state.calls.find(
      (candidate) => candidate.callId === returned.head.state.activeCallId,
    );
    if (!call) throw new Error("resumed Planner call missing");

    const extensionObjective =
      "Resolve only the newly established completion gap.";
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      const assignment = JSON.parse(messages[2]!.content) as Record<
        string,
        unknown
      >;
      expect(assignment).toMatchObject({
        planContext: {
          mode: "extend",
          planId: "plan-call-2",
          existingItemCount: 2,
          maxItems: 4,
        },
      });
      expect(assignment).not.toHaveProperty("availableDependencyResultRefs");
      expect(JSON.parse(messages[1]!.content)).toEqual({
        kind: "runtime_request_source_v1",
        authority: "reference_data",
        sourceRef: "request:planner-request",
        currentRequest: REQUEST_SOURCE_PROMPT,
      });
      expect(messages.slice(3)).toHaveLength(2);
      expect(
        messages.slice(3).every((message) => message.role === "user"),
      ).toBe(true);
      expect(
        messages
          .slice(3)
          .map((message) => JSON.parse(message.content))
          .every(
            (capsule) =>
              capsule.kind === "runtime_child_result" &&
              typeof capsule.delegatedObjective === "string",
          ),
      ).toBe(true);
      return {
        text: decisionText({
          action: "invoke_role",
          roleId: "worker",
          workingDirectory: WORKING_DIRECTORY,
          workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
          extension: {
            items: [
              {
                title: "Resolve completion gap",
                objective: extensionObjective,
              },
            ],
          },
          selectedItemIndexes: [0],
        }),
        meta: {},
      };
    });

    await expect(
      GENERIC_PLANNER_EXECUTOR.execute({
        context: createRequest(invoke),
        call,
        ledger,
        availableChildRoleIds: ["worker"],
        continuation: {
          kind: "role_child",
          commit,
        },
      }),
    ).resolves.toEqual({
      kind: "invoke_role",
      roleId: "worker",
      workingDirectory: WORKING_DIRECTORY,
      objective: extensionObjective,
      workerCapabilityScope: WORKER_CAPABILITY_SCOPE,
      plannerPlan: {
        mode: "extend",
        extension: {
          items: [
            {
              title: "Resolve completion gap",
              objective: extensionObjective,
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });
  });

  test("maps one exact child continuation to a terminal Planner result", async () => {
    const { ledger, commit, call, childSummary } =
      await createReturnedPlannerChild({
        includePendingItem: false,
        includeToolResult: true,
      });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const messages = input.messages as readonly Readonly<{
        role: string;
        content: string;
      }>[];
      const parsedMessages = messages.flatMap((message) => {
        try {
          return [JSON.parse(message.content) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      const toolResultBlocks = parsedMessages.filter(
        ({ kind }) => kind === "runtime_request_tool_results_v1",
      );
      expect(toolResultBlocks).toEqual([
        {
          kind: "runtime_request_tool_results_v1",
          authority: "reference_data",
          sourceRevision: ledger.current().revision,
          results: [
            {
              executionId: "capability-execution-1",
              callId: "call-3",
              invocationAttempt: 1,
              capabilityId: "test.observe",
              declaredEffect: "observation",
              outcome: "succeeded",
              observedEffect: "observation",
              summary: REQUEST_TOOL_RESULT_SUMMARY,
            },
          ],
        },
      ]);
      expect(toolResultBlocks[0]).not.toHaveProperty("objective");
      expect(toolResultBlocks[0]).not.toHaveProperty("dependencyResults");
      expect(
        parsedMessages.findIndex(
          ({ kind }) => kind === "runtime_request_tool_results_v1",
        ),
      ).toBeLessThan(
        parsedMessages.findIndex(({ kind }) => kind === "runtime_child_result"),
      );
      expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({
        kind: "runtime_child_result",
        callerCallId: call.callId,
        childCallId: "call-3",
        resultRef: "result-1",
        summary: childSummary,
      });
      return {
        text: decisionText({
          action: "return_result",
          result: "The bounded Planner objective is complete.",
        }),
        meta: {},
      };
    });
    const request = createRequest(invoke);

    await expect(
      GENERIC_PLANNER_EXECUTOR.execute({
        context: request,
        call,
        ledger,
        availableChildRoleIds: ["worker"],
        continuation: {
          kind: "role_child",
          commit,
        },
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "The bounded Planner objective is complete.",
    });
  });
});
