import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ModelGatewayClient } from "../ports.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerCommand,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import {
  createTestRequestExecutionScope,
  deriveTestRequestExecutionScope,
} from "./support/request-execution-scope.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  EXECUTION_AGENT_ROLE_EXECUTORS,
  EXECUTION_AGENT_V1_EXECUTION_POLICY,
} from "../request/role-executor-composition.js";
import {
  AUDITOR_DECISION_MODEL_STEP,
  EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID,
  buildAuditorDecisionInput,
  encodeExecutionAgentAuditObjective,
  parseAuditorDecisionOutput,
  projectAuditorAssignment,
  projectAuditorEvidenceProjectionStatus,
} from "../steps/auditor-decision/index.js";
import {
  PLANNER_GRAPH_MODEL_STEP,
  parsePlannerGraphOutput,
} from "../steps/planner-graph/index.js";

const runnerConfig: RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: "runtime-default",
      steps: {
        [PLANNER_GRAPH_MODEL_STEP]: PLANNER_GRAPH_MODEL_STEP,
        [AUDITOR_DECISION_MODEL_STEP]: AUDITOR_DECISION_MODEL_STEP,
      },
    },
  },
  context: {
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
  steps: {
    [PLANNER_GRAPH_MODEL_STEP]: { timeoutMs: 20_000 },
    [AUDITOR_DECISION_MODEL_STEP]: { timeoutMs: 20_000 },
  },
};

const modelPolicy = {
  providers: { local: { type: "ollama" as const } },
  profiles: {
    "runtime-default": {
      provider: "local",
      model: "runtime-default:latest",
      contextWindowTokens: 32_000,
      supportsThinking: true,
    },
  },
  defaults: {
    profileId: "runtime-default",
    steps: {
      [PLANNER_GRAPH_MODEL_STEP]: PLANNER_GRAPH_MODEL_STEP,
      [AUDITOR_DECISION_MODEL_STEP]: AUDITOR_DECISION_MODEL_STEP,
    },
  },
};

const proposal = Object.freeze({
  summary: "Produce two independently accepted outcomes.",
  nodes: Object.freeze([
    Object.freeze({
      localId: "alpha",
      title: "Alpha",
      objective: "Produce alpha.",
      dependsOn: Object.freeze([]),
      acceptanceCriteria: Object.freeze([
        Object.freeze({
          localId: "alpha_exists",
          description: "Alpha exists.",
          verification: "mechanical" as const,
        }),
      ]),
    }),
    Object.freeze({
      localId: "beta",
      title: "Beta",
      objective: "Produce beta.",
      dependsOn: Object.freeze([]),
      acceptanceCriteria: Object.freeze([
        Object.freeze({
          localId: "beta_quality",
          description: "Beta is coherent.",
          verification: "semantic" as const,
        }),
      ]),
    }),
  ]),
});

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

function createRequest(
  requestId: string,
  invoke: ModelGatewayClient["invoke"] = vi.fn(async () => ({
    text: JSON.stringify({ decision: proposal }),
    meta: {},
  })),
): RequestExecutionScope {
  return createTestRequestExecutionScope({
    requestId,
    sessionId: `${requestId}-session`,
    prompt: "Create the exact requested outcome.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig,
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

async function createLedger(requestId: string): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 32,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  return ledger;
}

async function openChild(
  ledger: RoleCallLedger,
  roleId: "planner" | "reviewer",
  objective: string,
): Promise<RoleCallFrame> {
  const root = requireActiveCall(ledger.current());
  const head = await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: root.callId,
    roleId,
    objective,
  });
  return requireActiveCall(head);
}

async function settleRootCapability(
  ledger: RoleCallLedger,
  referenceData: string,
  exactReferenceData: string = referenceData,
): Promise<void> {
  const root = requireActiveCall(ledger.current());
  const begun = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: root.callId,
      invocationAttempt: root.activationCount,
      capabilityId: "example.observe",
      declaredEffect: "observation",
      intent: "Observe the exact requested state.",
      controlsJson: "{}",
    },
  });
  if (!begun.ok || begun.effect.type !== "capability_execution_begun") {
    throw new Error("test_capability_begin_failed");
  }
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: root.callId,
    executionId: begun.effect.executionId,
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Observed the exact requested state.",
    referenceData,
    references: [{ kind: "tool_target", target: "result.txt" }],
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: {
        outcome: "succeeded",
        observedEffect: "observation",
        summary: "Observed the exact requested state.",
        referenceData: exactReferenceData,
      },
      references: [{ kind: "tool_target", target: "result.txt" }],
    },
  });
}

async function commit(
  ledger: RoleCallLedger,
  command: RoleCallLedgerCommand,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`test_commit_failed:${result.code}`);
  return result.head;
}

function requireActiveCall(head: RoleCallLedgerHead): RoleCallFrame {
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("test_active_call_missing");
  return call;
}

describe("execution-agent advisory Planner", () => {
  test("accepts a typed parallel graph and an explicit decline", () => {
    expect(
      parsePlannerGraphOutput(JSON.stringify({ decision: proposal }), {
        maxPlanNodes: 16,
        maxCriteriaPerNode: 8,
      }),
    ).toMatchObject({
      ok: true,
      decision: { outcome: "proposal", proposal },
    });
    expect(
      parsePlannerGraphOutput(
        JSON.stringify({
          decision: {
            action: "decline",
            reason: "Only one honest terminal deliverable exists.",
          },
        }),
        { maxPlanNodes: 16, maxCriteriaPerNode: 8 },
      ),
    ).toEqual({
      ok: true,
      decision: {
        outcome: "decline",
        reason: "Only one honest terminal deliverable exists.",
      },
    });
  });

  test("rejects a serial or cyclic proposal at the advisory contract", () => {
    const serial = {
      ...proposal,
      nodes: [
        proposal.nodes[0],
        { ...proposal.nodes[1], dependsOn: ["alpha"] },
      ],
    };
    expect(
      parsePlannerGraphOutput(JSON.stringify({ decision: serial }), {
        maxPlanNodes: 16,
        maxCriteriaPerNode: 8,
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "insufficient_terminal_deliverables" }),
      ]),
    });
    const cyclic = {
      ...proposal,
      nodes: [
        { ...proposal.nodes[0], dependsOn: ["beta"] },
        { ...proposal.nodes[1], dependsOn: ["alpha"] },
      ],
    };
    expect(
      parsePlannerGraphOutput(JSON.stringify({ decision: cyclic }), {
        maxPlanNodes: 16,
        maxCriteriaPerNode: 8,
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "cyclic_plan_graph" }),
      ]),
    });
  });

  test("settles exhausted invalid model output as a passive failed result", async () => {
    const ledger = await createLedger("planner-invalid-request");
    const callerCall = requireActiveCall(ledger.current());
    const invoke = vi.fn(
      async (_input: Parameters<ModelGatewayClient["invoke"]>[0]) => ({
        text: "not-json",
        meta: {},
      }),
    );

    await expect(
      EXECUTION_AGENT_ROLE_EXECUTORS.invokeChild({
        requestId: "planner-invalid-request",
        context: createRequest("planner-invalid-request", invoke),
        callerCall,
        ledger,
        expectedHead: ledger.current(),
        roleId: "planner",
        objective: "Advise on a bounded decomposition.",
        turnCount: 0,
      }),
    ).resolves.toMatchObject({
      execution: {
        kind: "terminal",
        outcome: "failed",
        summary: expect.stringContaining('"reason":"invalid_planner_graph"'),
      },
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      PLANNER_GRAPH_MODEL_STEP,
      PLANNER_GRAPH_MODEL_STEP,
      PLANNER_GRAPH_MODEL_STEP,
    ]);
    expect(invoke.mock.calls[0]?.[0].format).toMatchObject({
      name: "planner_graph_proposal",
    });
    expect(ledger.current().state.activeCallId).toBe(callerCall.callId);
    expect(ledger.current().state.results).toMatchObject([
      { roleId: "planner", outcome: "failed" },
    ]);
  });
});

describe("execution-agent advisory Auditor", () => {
  test("binds criteria mechanically and projects exact caller evidence only", async () => {
    const ledger = await createLedger("auditor-projection-request");
    const legacyReferenceData = "LEGACY_AUDITOR_REFERENCE_DATA";
    const exactReferenceData = "EXACT_ADAPTER_RESULT_SENTINEL";
    await settleRootCapability(ledger, legacyReferenceData, exactReferenceData);
    const requestSteering = createRequestSteeringInbox({
      requestId: "auditor-projection-request",
    });
    expect(
      requestSteering.append({
        steerId: "auditor-update-1",
        text: "Preserve the exact updated target.",
      }),
    ).toMatchObject({ ok: true, duplicate: false });
    const call = await openChild(
      ledger,
      "reviewer",
      encodeExecutionAgentAuditObjective(
        [EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID],
        1,
      ),
    );
    const request = deriveTestRequestExecutionScope(
      createRequest("auditor-projection-request"),
      { requestSteering },
    );
    const assignment = projectAuditorAssignment(
      request,
      ledger.current(),
      call,
    );

    expect(assignment).toMatchObject({
      auditId: call.callId,
      callerCallId: "call-1",
      criterionIds: [EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID],
      availableEvidenceCount: 1,
      omittedEvidenceCount: 0,
      evidence: [
        {
          kind: "capability_result",
          executionId: "capability-execution-1",
          referenceData: legacyReferenceData,
          adapterResult: {
            kind: "generic_capability_result_v1",
            payload: { referenceData: exactReferenceData },
          },
        },
      ],
    });
    const evidence = assignment.evidence[0]!;
    expect(evidence.kind).toBe("capability_result");
    if (evidence.kind !== "capability_result") {
      throw new Error("expected capability evidence");
    }
    expect(evidence.adapterResult).toBe(
      ledger.current().state.capabilityExecutions[0]!.exactResult,
    );
    expect(JSON.parse(assignment.target)).toEqual({
      kind: "runtime_active_request_intent_v1",
      authority: "user",
      currentRequest: request.prompt,
      steeringVersion: 1,
      updates: [{ sequence: 1, text: "Preserve the exact updated target." }],
    });
    expect(projectAuditorEvidenceProjectionStatus(assignment).complete).toBe(
      true,
    );
    const input = buildAuditorDecisionInput(request, ledger.current(), call);
    const serialized = input.context.messages
      .map(({ content }) => content)
      .join("\n");
    expect(serialized).toContain(exactReferenceData);
    expect(serialized.match(new RegExp(request.prompt, "gu"))).toHaveLength(1);
  });

  test("admits only whole bounded evidence and mechanically disables pass after omission", async () => {
    const ledger = await createLedger("auditor-bounded-request");
    const omittedExactResult = `OMITTED_EXACT_RESULT:${"a".repeat(30_000)}`;
    const admittedExactResult = `ADMITTED_EXACT_RESULT:${"b".repeat(30_000)}`;
    await settleRootCapability(
      ledger,
      "bounded legacy evidence A",
      omittedExactResult,
    );
    await settleRootCapability(
      ledger,
      "bounded legacy evidence B",
      admittedExactResult,
    );
    const call = await openChild(
      ledger,
      "reviewer",
      encodeExecutionAgentAuditObjective([
        EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID,
      ]),
    );
    const assignment = projectAuditorAssignment(
      createRequest("auditor-bounded-request"),
      ledger.current(),
      call,
    );
    expect(assignment.availableEvidenceCount).toBe(2);
    expect(assignment.evidence).toHaveLength(1);
    expect(assignment.omittedEvidenceCount).toBe(1);
    const serializedEvidence = JSON.stringify(assignment.evidence);
    expect(serializedEvidence).toContain(admittedExactResult);
    expect(serializedEvidence).not.toContain("OMITTED_EXACT_RESULT");
    expect(projectAuditorEvidenceProjectionStatus(assignment).complete).toBe(
      false,
    );
    expect(
      parseAuditorDecisionOutput(
        JSON.stringify({
          decision: {
            auditId: call.callId,
            verdict: "pass",
            criterionIds: [EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID],
            gaps: [],
          },
        }),
        assignment,
      ),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "auditor_pass_evidence_incomplete" }),
      ]),
    });
  });

  test("settles exhausted invalid model output without child or capability action", async () => {
    const ledger = await createLedger("auditor-invalid-request");
    await settleRootCapability(ledger, "bounded evidence");
    const callerCall = requireActiveCall(ledger.current());
    const invoke = vi.fn(async () => ({ text: "not-json", meta: {} }));

    await expect(
      EXECUTION_AGENT_ROLE_EXECUTORS.invokeChild({
        requestId: "auditor-invalid-request",
        context: createRequest("auditor-invalid-request", invoke),
        callerCall,
        ledger,
        expectedHead: ledger.current(),
        roleId: "reviewer",
        objective: encodeExecutionAgentAuditObjective([
          EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID,
        ]),
        turnCount: 0,
      }),
    ).resolves.toMatchObject({
      execution: {
        kind: "terminal",
        outcome: "failed",
        summary: expect.stringContaining('"reason":"invalid_auditor_decision"'),
      },
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(ledger.current().state.activeCallId).toBe(callerCall.callId);
    expect(ledger.current().state.results).toMatchObject([
      { roleId: "reviewer", outcome: "failed" },
    ]);
  });
});
