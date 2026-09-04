import { describe, expect, test, vi } from "vitest";

import type { ChatMessage } from "../../model-gateway/types.js";
import { buildRequestToolResultsMessage } from "../context/request-tool-results.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../request/worker-capability-payload.js";
import {
  projectWorkerCapabilityAssignmentProvenance,
  WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
  type WorkerCapabilityAssignmentProvenance,
} from "../orchestration/worker-capabilities/index.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  WORKER_DECISION_MODEL_STEP,
  WORKER_RESULT_MODEL_STEP,
} from "../steps/worker-decision/contracts.js";
import { prepareWorkerReferenceContext } from "../steps/worker-decision/input/reference-context.js";
import type { PreparedWorkerDecisionSession } from "../steps/worker-decision/input/types.js";
import { runWorkerResultAuthor } from "../steps/worker-decision/result-author.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

const PLANNER_ASSIGNMENT_SCOPE = Object.freeze({
  sourceRevision: 7,
  scopeCallId: "planner-call",
  scopeRoleId: "planner" as const,
  scopeObjective: "Implement the complete multi-file feature.",
});

const WORKER_CALL = Object.freeze({
  callId: "worker-call",
  parentCallId: "planner-call",
  roleId: "worker" as const,
  depth: 2,
  objective: "Create only the shortlist button markup in index.html.",
  dependencyResultRefs: Object.freeze([]),
  status: "waiting_for_capability" as const,
  childCallIds: Object.freeze([]),
  activationCount: 1,
  resultRef: null,
});

const SCOPED_TOOL_RESULTS = Object.freeze({
  sourceRevision: 7,
  scope: Object.freeze({ kind: "call" as const, callId: WORKER_CALL.callId }),
  results: Object.freeze([
    Object.freeze({
      executionId: "worker-execution",
      callId: WORKER_CALL.callId,
      invocationAttempt: 1,
      capabilityId: "write_complete_file",
      declaredEffect: "mutation" as const,
      outcome: "succeeded" as const,
      observedEffect: "mutation" as const,
      summary: "Current Worker evidence remains available.",
    }),
  ]),
});

const DESCRIPTOR = Object.freeze({
  capabilityId: "write_complete_file",
  summary: "Write one complete file.",
  effect: "mutation" as const,
  requiresPayloadAuthoringObjective: true as const,
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
});

describe("Planner-owned Worker context isolation", () => {
  test("derives the payload marker only from a directly bound Planner item", () => {
    const assignment = plannerAssignment("request-1");
    expect(Object.isFrozen(assignment.provenance)).toBe(true);
    expect(assignment.provenance).toMatchObject({
      kind: "planner_plan_item_v1",
      requestId: "request-1",
      plannerCallId: "planner-call",
      workerCallId: WORKER_CALL.callId,
      invocationAttempt: WORKER_CALL.activationCount,
    });
    const reviewer = roleCall({
      callId: "reviewer-call",
      parentCallId: assignment.planner.callId,
      roleId: "reviewer",
      depth: 2,
    });
    const reviewerWorker = roleCall({
      callId: "reviewer-worker-call",
      parentCallId: reviewer.callId,
      roleId: "worker",
      depth: 3,
    });
    const nestedHead = assignmentHead({
      requestId: "nested-request",
      calls: [assignment.planner, reviewer, reviewerWorker],
      plannerCallId: assignment.planner.callId,
      workerCallId: reviewerWorker.callId,
    });
    expect(
      projectWorkerCapabilityAssignmentProvenance({
        head: nestedHead,
        call: reviewerWorker,
      }),
    ).toBeUndefined();
  });

  test("projects only the bound plan item and evidence into Worker decisions", () => {
    const references = plannerReferences("request-1", SCOPED_TOOL_RESULTS);

    expect(messageKinds(references.baseReferenceMessages)).not.toContain(
      "runtime_request_source_v1",
    );
    expect(messageKinds(references.baseReferenceMessages)).not.toContain(
      "runtime_role_call_assignment_scope_v1",
    );
    expect(references.resultAuthorSource.assignmentProvenance?.kind).toBe(
      "planner_plan_item_v1",
    );
    expect(
      references.resultAuthorSource.requestToolResults.results.map(
        ({ executionId }) => executionId,
      ),
    ).toEqual(["worker-execution"]);
    expect(references.requestToolResultsMessage?.content).toContain(
      "worker-execution",
    );
    expect(references.requestToolResultsMessage?.content).toContain(
      '"coverage":{"kind":"call","callId":"worker-call"}',
    );
  });

  test("keeps the full request out of the Planner-owned result author", async () => {
    const references = plannerReferences("planner-result", SCOPED_TOOL_RESULTS);
    const diagnostic = {
      requestId: "planner-result",
      modelStep: WORKER_DECISION_MODEL_STEP,
      decisionPhase: "capability_selection" as const,
      callId: WORKER_CALL.callId,
      parentCallId: WORKER_CALL.parentCallId,
      depth: WORKER_CALL.depth,
      invocationAttempt: WORKER_CALL.activationCount,
    };
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      const messages = input.messages as readonly ChatMessage[];
      expect(input.modelStep).toBe(WORKER_RESULT_MODEL_STEP);
      expect(messageKinds(messages)).not.toContain("runtime_request_source_v1");
      expect(JSON.stringify(messages)).toContain("worker-execution");
      return { text: "Current item completed.", meta: {} };
    });

    await expect(
      runWorkerResultAuthor(payloadRequest(invoke, "planner-result"), {
        diagnostic,
        source: references.resultAuthorSource,
      }),
    ).resolves.toBe("Current item completed.");

    const { assignmentProvenance: _dropped, ...unscopedSource } =
      references.resultAuthorSource;
    await expect(
      runWorkerResultAuthor(payloadRequest(invoke, "planner-result"), {
        diagnostic,
        source: Object.freeze(unscopedSource),
      }),
    ).rejects.toThrow("worker_result_source_context_invalid");
  });

  test("rejects a prebuilt tool-result message from another view", () => {
    const otherView = Object.freeze({ ...SCOPED_TOOL_RESULTS });
    const message = buildRequestToolResultsMessage(otherView);
    expect(() =>
      plannerReferences("stale-tool-results", SCOPED_TOOL_RESULTS, message),
    ).toThrow("worker_tool_results_message_binding_invalid");
  });

  test("omits the full request from Planner-owned payload authoring", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      expect(
        messageKinds(input.messages as readonly ChatMessage[]),
      ).not.toContain("runtime_request_source_v1");
      return { text: "<button>Save</button>\n", meta: {} };
    });
    const author = createRequestWorkerCapabilityPayloadAuthor(
      payloadRequest(invoke, "planner-payload"),
    );
    const { provenance } = plannerAssignment("planner-payload");
    const payloadInput = Object.freeze({
      call: WORKER_CALL,
      authoringObjective: "Write only the shortlist button markup.",
      executionId: "execution-1",
      descriptor: DESCRIPTOR,
      controls: { path: "index.html" },
      settledCapabilityResults: Object.freeze([]),
      contract: {
        instructions: "Return the complete file body.",
        minBytes: 1,
        maxBytes: 1_024,
      },
    });

    await expect(
      author.author({
        ...payloadInput,
        assignmentProvenance: provenance,
      }),
    ).resolves.toEqual({ status: "authored", body: "<button>Save</button>\n" });
    await expect(author.author(payloadInput)).resolves.toEqual({
      status: "failed",
      code: "payload_context_invalid",
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  test("rejects a forged Planner marker on a direct Supervisor Worker", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
      text: "must not be called",
      meta: {},
    }));
    const author = createRequestWorkerCapabilityPayloadAuthor(
      payloadRequest(invoke, "forged-planner-marker"),
    );
    const forgedProvenance = Object.freeze({
      kind: "planner_plan_item_v1",
      requestId: "forged-planner-marker",
      sourceRevision: 7,
      plannerCallId: "supervisor-call",
      planId: "forged-plan",
      itemId: "forged-item",
      workerCallId: WORKER_CALL.callId,
      invocationAttempt: WORKER_CALL.activationCount,
    }) as unknown as WorkerCapabilityAssignmentProvenance;
    const payloadInput = Object.freeze({
      call: Object.freeze({
        ...WORKER_CALL,
        parentCallId: "supervisor-call",
        depth: 1,
      }),
      authoringObjective: "Write the exact requested body.",
      executionId: "execution-1",
      descriptor: DESCRIPTOR,
      controls: { path: "result.txt" },
      settledCapabilityResults: Object.freeze([]),
      contract: {
        instructions: "Return the complete file body.",
        minBytes: 1,
        maxBytes: 1_024,
      },
    });

    await expect(author.author(payloadInput)).resolves.toEqual({
      status: "failed",
      code: "payload_context_invalid",
    });
    await expect(
      author.author({
        ...payloadInput,
        assignmentProvenance: forgedProvenance,
      }),
    ).resolves.toEqual({ status: "failed", code: "payload_context_invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });

  test("rejects a canonical Planner receipt replayed into another request", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>();
    const author = createRequestWorkerCapabilityPayloadAuthor(
      payloadRequest(invoke, "replay-target-request"),
    );
    const { provenance } = plannerAssignment("receipt-source-request");

    await expect(
      author.author({
        call: WORKER_CALL,
        assignmentProvenance: provenance,
        authoringObjective: "Write only the shortlist button markup.",
        executionId: "execution-1",
        descriptor: DESCRIPTOR,
        controls: { path: "index.html" },
        settledCapabilityResults: Object.freeze([]),
        contract: {
          instructions: "Return the complete file body.",
          minBytes: 1,
          maxBytes: 1_024,
        },
      }),
    ).resolves.toEqual({ status: "failed", code: "payload_context_invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

function plannerReferences(
  requestId: string,
  requestToolResults: typeof SCOPED_TOOL_RESULTS,
  requestToolResultsContextMessage?: ChatMessage,
) {
  const { provenance } = plannerAssignment(requestId);
  return prepareWorkerReferenceContext({
    request: {
      requestId,
      prompt: "Implement the complete shortlist feature across all files.",
      historyMessages: Object.freeze([]),
    },
    options: {
      call: WORKER_CALL,
      requestToolResults,
      ...(requestToolResultsContextMessage
        ? { requestToolResultsContextMessage }
        : {}),
    },
    callIdentity: {
      callId: WORKER_CALL.callId,
      parentCallId: WORKER_CALL.parentCallId,
      depth: WORKER_CALL.depth,
      invocationAttempt: WORKER_CALL.activationCount,
    },
    diagnostic: {
      requestId: "request-1",
      role: "worker",
      modelStep: WORKER_DECISION_MODEL_STEP,
      decisionPhase: "initial",
      callId: WORKER_CALL.callId,
      parentCallId: WORKER_CALL.parentCallId,
      depth: WORKER_CALL.depth,
      invocationAttempt: WORKER_CALL.activationCount,
    },
    objective: WORKER_CALL.objective,
    canonicalState: {
      canonicalSource: undefined,
      assignmentScope: PLANNER_ASSIGNMENT_SCOPE,
      assignmentProvenance: provenance,
      dependencyResults: Object.freeze([]),
      resume: undefined,
      operationSupervision: undefined,
    },
  } as unknown as PreparedWorkerDecisionSession);
}

function payloadRequest(
  invoke: ModelGatewayClient["invoke"],
  requestId: string,
) {
  return createTestRequestExecutionScope({
    requestId,
    sessionId: `${requestId}-session`,
    prompt: "Implement the complete shortlist feature across all files.",
    historyMessages: Object.freeze([]),
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: { defaults: { profileId: "payload-test", steps: {} } },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: {
        [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: { timeoutMs: 20_000 },
        [WORKER_RESULT_MODEL_STEP]: { timeoutMs: 20_000 },
      } as RequestExecutionSeed["runnerConfig"]["steps"],
    },
    agentMode: "reasoning" as const,
    modelPolicy: {
      providers: { "payload-test-provider": { type: "ollama" as const } },
      profiles: {
        "payload-test": {
          provider: "payload-test-provider",
          model: "payload-test:latest",
          contextWindowTokens: 16_000,
        },
      },
      defaults: {
        profileId: "payload-test",
        steps: {
          [WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP]: "toolPayload.raw",
          [WORKER_RESULT_MODEL_STEP]: "supervisor.response",
        },
      },
    },
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

function messageKinds(messages: readonly ChatMessage[]): string[] {
  return messages.flatMap(({ content }) => {
    try {
      const parsed = JSON.parse(content) as { kind?: unknown };
      return typeof parsed.kind === "string" ? [parsed.kind] : [];
    } catch {
      return [];
    }
  });
}

function plannerAssignment(requestId: string) {
  const planner = roleCall({
    callId: "planner-call",
    parentCallId: "supervisor-call",
    roleId: "planner",
    depth: 1,
  });
  const head = assignmentHead({
    requestId,
    calls: [planner, WORKER_CALL],
    plannerCallId: planner.callId,
    workerCallId: WORKER_CALL.callId,
  });
  const provenance = projectWorkerCapabilityAssignmentProvenance({
    head,
    call: WORKER_CALL,
  });
  if (!provenance) throw new Error("Planner assignment provenance missing");
  return { planner, head, provenance };
}

function roleCall(
  input: Pick<RoleCallFrame, "callId" | "parentCallId" | "roleId" | "depth">,
): RoleCallFrame {
  return Object.freeze({
    ...input,
    objective: `${input.roleId} objective`,
    dependencyResultRefs: Object.freeze([]),
    status: "active" as const,
    childCallIds: Object.freeze([]),
    activationCount: 1,
    resultRef: null,
  });
}

function assignmentHead(
  input: Readonly<{
    requestId: string;
    calls: readonly RoleCallFrame[];
    plannerCallId: string;
    workerCallId: string;
  }>,
): RoleCallLedgerHead {
  return {
    revision: 7,
    state: {
      requestId: input.requestId,
      calls: input.calls,
      plans: [
        {
          definition: {
            planId: "plan-1",
            plannerCallId: input.plannerCallId,
            version: 1,
            summary: "Plan",
            items: [
              {
                itemId: "item-1",
                title: "Current item",
                objective: "Implement only the current item.",
              },
            ],
          },
          itemStates: [
            {
              itemId: "item-1",
              status: "in_progress",
              childCallId: input.workerCallId,
            },
          ],
        },
      ],
    },
  } as unknown as RoleCallLedgerHead;
}
