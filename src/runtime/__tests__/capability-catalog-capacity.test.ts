import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createBoundCapabilityCatalog } from "../orchestration/worker-capabilities/binding/adapter-catalog.js";
import {
  createRoleCallLedger,
  type RoleCallFrame,
} from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityDescriptor } from "../orchestration/worker-capabilities/index.js";
import {
  createWorkerDecisionFormat,
  parseWorkerDecisionOutput,
} from "../steps/worker-decision/index.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import {
  buildExecutionAgentInput,
  createExecutionAgentDecisionFormat,
  parseExecutionAgentDecisionOutput,
} from "../steps/execution-agent/index.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function capabilities(count: number): readonly WorkerCapabilityDescriptor[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        capabilityId: `observe_${index}`,
        summary: "Observe one source.",
        effect: "observation" as const,
        catalogGroups: ["read"],
        controls: {
          type: "object" as const,
          additionalProperties: false as const,
          properties: {},
          required: [],
        },
      }),
    ),
  );
}

function provider(operationIds: readonly string[]) {
  const declarations = operationIds.map(
    (operationId, index): ToolModuleDeclaration => ({
      definition: {
        name: `tool_${index}`,
        routingCapability: "semantic_lookup",
        catalogGroups: ["read"],
      },
      normalInvocation: {
        version: 1,
        operations: [
          {
            operationId,
            summary: "Observe one source.",
            effect: "read_only",
            approval: "request_policy",
            input: {
              type: "object",
              additionalProperties: false,
              properties: {},
              required: [],
            },
          },
        ],
      },
      implementation: async () => {
        throw new Error("catalog test must not execute a tool");
      },
    }),
  );
  const registry = createConfiguredToolRegistry(undefined, declarations);
  return createRegisteredToolWorkerCapabilityProvider({
    getRequestToolRegistry: () => registry,
    requestId: "capacity",
    sessionId: "capacity",
    abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access",
    nextApprovalId: () => "unused",
  });
}

function bindCatalog(descriptors: readonly WorkerCapabilityDescriptor[]) {
  const call: RoleCallFrame = {
    callId: "worker",
    parentCallId: "root",
    roleId: "worker",
    depth: 1,
    objective: "Observe sources.",
    dependencyResultRefs: [],
    status: "active",
    childCallIds: [],
    activationCount: 1,
    resultRef: null,
  };
  return createBoundCapabilityCatalog({
    adapters: descriptors.map((descriptor) => ({
      descriptor,
      execute: async () => {
        throw new Error("must not execute");
      },
    })),
    boundCall: call,
    emptyDiagnostic: {
      requestId: "capacity",
      call,
      capabilityIds: [],
      scopeMode: "full",
      scopeCatalogGroupIds: [],
      knownCatalogGroupCount: 0,
      fullCapabilityCount: descriptors.length,
      filteredCapabilityCount: 0,
    },
  });
}

function requestWithCatalog(
  descriptors: readonly WorkerCapabilityDescriptor[],
) {
  const invoke = vi.fn(async () => {
    throw new Error("capacity test must not invoke a model");
  });
  return createTestRequestExecutionScope({
    requestId: "capacity",
    sessionId: "capacity",
    prompt: "Observe sources.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: { defaults: { profileId: "fixture", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: {},
    },
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        fixture: {
          provider: "local",
          model: "fixture",
          contextWindowTokens: 64000,
        },
      },
      defaults: { profileId: "fixture" },
    },
    executionPolicySelection: {
      policy: "execution-agent-v1",
      primaryProfileId: "fixture",
      source: "model_profile",
    },
    workerCapabilityProvider: {
      getDescriptors: () => descriptors,
      getAdapters: () => [],
    },
    agentMode: "reasoning",
    modelGatewayClient: { invoke, invokeRaw: invoke },
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

test("registered catalog admits 128 distinct descriptors and adapters", () => {
  const ids = capabilities(128).map(({ capabilityId }) => capabilityId);
  const source = provider(ids);
  expect(
    source.getDescriptors().map(({ capabilityId }) => capabilityId),
  ).toEqual(ids);
  expect(
    source.getAdapters().map(({ descriptor }) => descriptor.capabilityId),
  ).toEqual(ids);
});

test("registered catalog rejects 129 operations and still rejects duplicate identities", () => {
  expect(() =>
    provider(
      capabilities(129).map(({ capabilityId }) => capabilityId),
    ).getDescriptors(),
  ).toThrow("operation_count_exceeded");
  expect(() => provider(["duplicate", "duplicate"]).getDescriptors()).toThrow(
    "operation_ambiguous",
  );
});

test("binding accepts 128 and preserves the excessive-count and duplicate guards", () => {
  expect(bindCatalog(capabilities(128)).capabilities).toHaveLength(128);
  expect(() => bindCatalog(capabilities(129))).toThrow(
    "capability_count_invalid",
  );
  const duplicate = capabilities(1)[0]!;
  expect(() => bindCatalog([duplicate, duplicate])).toThrow(
    "duplicate_capability_id",
  );
});

test("Worker and Execution Agent formats and parsers retain the last capability above 64", () => {
  const descriptors = capabilities(128);
  const decision = {
    action: "invoke_capability",
    capabilityId: "observe_127",
    intent: "Observe the selected source.",
  };
  expect(() =>
    createWorkerDecisionFormat({ capabilities: descriptors }),
  ).not.toThrow();
  expect(
    parseWorkerDecisionOutput(JSON.stringify({ decision }), undefined, {
      availableCapabilities: descriptors,
    }),
  ).toMatchObject({ ok: true, decision: { capabilityId: "observe_127" } });
  expect(() =>
    createExecutionAgentDecisionFormat({ capabilities: descriptors }),
  ).not.toThrow();
  expect(
    parseExecutionAgentDecisionOutput(JSON.stringify({ decision }), {
      capabilities: descriptors,
    }),
  ).toMatchObject({ ok: true, decision: { capabilityId: "observe_127" } });
  expect(() =>
    createWorkerDecisionFormat({ capabilities: capabilities(129) }),
  ).toThrow("worker_capabilities_invalid");
  expect(() =>
    createExecutionAgentDecisionFormat({ capabilities: capabilities(129) }),
  ).toThrow("execution_agent_capabilities_invalid");
});

test("Supervisor accepts 128 passive affordances while retaining its upper bound", () => {
  const descriptors = capabilities(128);
  const request = requestWithCatalog(descriptors);
  const affordances = descriptors.map(({ summary, effect }) => ({
    purpose: summary,
    effect,
  }));
  const options = {
    toolResults: { sourceRevision: 0, results: [] },
    allowedRoleIds: ["worker" as const],
    workerCapabilityAffordances: affordances,
  };
  expect(
    buildSupervisorDecisionInput(request, options).workerCapabilityAffordances,
  ).toHaveLength(128);
  expect(() =>
    buildSupervisorDecisionInput(request, {
      ...options,
      workerCapabilityAffordances: [...affordances, affordances[0]!],
    }),
  ).toThrow("supervisor_worker_capability_affordances_invalid");
  expect(request.modelGatewayClient.invoke).not.toHaveBeenCalled();
});

test("larger catalogs do not raise the Execution Agent batch contract above 64", () => {
  const descriptors = capabilities(128);
  expect(() =>
    createExecutionAgentDecisionFormat({
      capabilities: descriptors,
      maxBatchCapabilityExecutions: 64,
    }),
  ).not.toThrow();
  expect(() =>
    createExecutionAgentDecisionFormat({
      capabilities: descriptors,
      maxBatchCapabilityExecutions: 65,
    }),
  ).toThrow("execution_agent_capabilities_invalid");
  const invocations = descriptors.slice(0, 65).map(({ capabilityId }) => ({
    capabilityId,
    intent: "Observe source.",
  }));
  expect(
    parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: { action: "invoke_capabilities", invocations },
      }),
      { capabilities: descriptors, maxBatchCapabilityExecutions: 64 },
    ),
  ).toMatchObject({
    ok: false,
    issues: [
      expect.objectContaining({
        code: "execution_agent_capability_batch_invalid",
      }),
    ],
  });
  expect(
    parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capabilities",
          invocations: invocations.slice(0, 64),
        },
      }),
      { capabilities: descriptors, maxBatchCapabilityExecutions: 64 },
    ),
  ).toMatchObject({ ok: true });
});

test("production Execution Agent input keeps a 128-item active catalog and the existing batch64 bound", async () => {
  const request = requestWithCatalog(capabilities(128));
  const ledger = createRoleCallLedger({
    requestId: request.requestId,
    policy: {
      authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      limits: {
        maxDepth: 12,
        maxCalls: 48,
        maxCapabilityExecutions: 96,
        maxObjectiveChars: 8192,
        maxResultChars: 65536,
        maxResponseChars: 65536,
      },
    },
  });
  const created = await ledger.apply({
    expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" },
  });
  expect(created.ok).toBe(true);
  const call = ledger.current().state.calls[0]!;
  const scoped = await ledger.apply({
    expectedHead: ledger.current(),
    command: {
      authority: "active_role",
      type: "update_capability_scope",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      mode: "open",
      catalogGroupIds: ["read"],
    },
  });
  expect(scoped.ok).toBe(true);
  const head = ledger.current();
  const input = buildExecutionAgentInput(request, {
    head,
    call: head.state.calls[0]!,
    steeringSnapshot: createRequestSteeringInbox({
      requestId: request.requestId,
    }).snapshot(),
    includeAcknowledgement: false,
    includeTitle: false,
    allowPlanner: false,
    allowAuditor: false,
  });
  expect(input.capabilities).toHaveLength(128);
  expect(input.contract.maxBatchCapabilityExecutions).toBe(64);
  expect(request.modelGatewayClient.invoke).not.toHaveBeenCalled();
});
