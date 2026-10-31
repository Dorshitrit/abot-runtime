import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import type { ModelGatewayClient, ToolRegistry } from "../ports.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { createRequestSteeringInbox, REQUEST_STEERING_MESSAGE_KIND } from "../request/request-steering.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";
import { runnerConfig, modelPolicy, separateSupervisorRunnerModelPhases } from "./support/supervisor-runner-model-phases.js";
import { workerEvidenceReply } from "./support/worker-evidence-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
function capsules(input: ModelInput, kind: string): Record<string, unknown>[] {
  return (input.messages as ChatMessage[]).flatMap(({ content }) => {
    try { const value = JSON.parse(content); return value?.kind === kind ? [value] : []; }
    catch { return []; }
  });
}
function reply(decision: unknown) { return { text: JSON.stringify({ decision }), meta: {} }; }

function registration(staged: boolean): RegisteredToolNormalInvocation {
  return {
    toolName: "fixture_search",
    definition: {
      name: "fixture_search", routingCapability: "web_lookup", catalogGroups: ["read"],
      params: { query: "string", ...(staged ? { selection: "string" as const } : {}) },
      payloadChannelSpec: {
        params: staged ? ["selection", "query"] : ["query"],
        outputParam: "query", generationMode: "raw_text",
        ...(staged ? { stages: [
          {
            outputParam: "selection", promptHint: "Select the requested topic.",
            responseFormat: {
              type: "object", additionalProperties: false,
              properties: { topic: { type: "string" } }, required: ["topic"],
            },
          },
          { outputParam: "query", includeMaterializedParams: ["selection"], promptHint: "Write the complete search query." },
        ] } : {}),
      },
    },
    contract: { version: 1, operations: [{
      operationId: "search_articles", summary: "Search for the requested articles.",
      input: {
        type: "object", additionalProperties: false,
        properties: staged ? { selection: { type: "string", minLength: 1, maxLength: 512 } } : {},
        required: staged ? ["selection"] : [],
      },
      payload: { kind: "raw_text", param: "query", instructions: "Return only the complete query.", minBytes: 1, maxBytes: 1024 },
      effect: "read_only", approval: "request_policy",
    }] },
  };
}

test.each([
  { caller: "supervisor", staged: false }, { caller: "supervisor", staged: true },
  { caller: "planner", staged: false }, { caller: "planner", staged: true },
] as const)("$caller replacement Worker authors and dispatches a payload after a yielded dependency (staged=$staged)", async ({ caller, staged }) => {
  const requestId = `steering-payload-${caller}-${staged}`;
  const steering = createRequestSteeringInbox({ requestId });
  const originalObjective = "Find technology articles.";
  const updatedObjective = "Find technology articles including GPT articles.";
  const update = "Include GPT articles too.";
  const finalOutput = "Found the requested technology and GPT articles.";
  const firstWorkerCallId = caller === "supervisor" ? "call-2" : "call-3";
  const replacementCallId = caller === "supervisor" ? "call-3" : "call-4";
  const callerCallId = caller === "supervisor" ? "call-1" : "call-2";
  const tool = registration(staged);
  const execute = vi.fn<ToolRegistry["execute"]>(async (call) => ({
    ok: true, tool: call.tool, output: finalOutput, progress: true, producedNewInformation: true,
  }));
  const registry: ToolRegistry = {
    listDefinitions: () => [tool.definition], listNormalInvocations: () => [tool],
    getDefinition: (name) => name === tool.toolName ? tool.definition : undefined,
    hasToolsAvailable: () => true, getImplementations: () => ({}),
    prepareSharedState: (state = {}) => state, execute,
  };
  let rootDecisions = 0;
  let plannerDecisions = 0;
  let workerDecisions = 0;
  let workerResults = 0;
  const payloadContexts: Record<string, unknown>[] = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "supervisor.decision") {
      rootDecisions += 1;
      if (rootDecisions === 1) return reply({
        action: "invoke_role", roleId: caller === "supervisor" ? "worker" : "planner", objective: originalObjective,
      });
      if (caller === "supervisor" && rootDecisions === 2) {
        expect(capsules(input, "runtime_child_result")).toEqual([
          expect.objectContaining({ childCallId: firstWorkerCallId, outcome: "yielded", steeringVersion: 1 }),
        ]);
        expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toEqual([
          expect.objectContaining({ version: 1, updates: [{ sequence: 1, text: update }] }),
        ]);
        return reply({ action: "invoke_role", roleId: "worker", objective: updatedObjective,
          workerCapabilityScope: { catalogGroupIds: ["read"] } });
      }
      return reply({ action: "respond" });
    }
    if (input.modelStep === "planner.decision") {
      plannerDecisions += 1;
      if (plannerDecisions === 1) return reply({
        action: "invoke_role", roleId: "worker", workerCapabilityScope: { catalogGroupIds: ["read"] },
        plan: { summary: "Find articles.", items: [{ title: "Search", objective: originalObjective }] },
        selectedItemIndexes: [0],
      });
      if (plannerDecisions === 2) {
        expect(capsules(input, "runtime_child_result")).toEqual([
          expect.objectContaining({ childCallId: firstWorkerCallId, outcome: "yielded", steeringVersion: 1 }),
        ]);
        expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toEqual([
          expect.objectContaining({ version: 1, updates: [{ sequence: 1, text: update }] }),
        ]);
        return reply({
          action: "invoke_role", roleId: "worker", workerCapabilityScope: { catalogGroupIds: ["read"] },
          extension: { items: [{ title: "Updated search", objective: updatedObjective }] }, selectedItemIndexes: [0],
        });
      }
      expect(capsules(input, "runtime_child_result").map((child) => child.outcome)).toEqual(["yielded", "completed"]);
      return reply({ action: "return_result", result: finalOutput });
    }
    if (input.modelStep === "worker.evidence") return workerEvidenceReply(input, execute.mock.calls.length === 0);
    if (input.modelStep === "worker.decision") {
      workerDecisions += 1;
      expect(workerDecisions).toBeLessThanOrEqual(2);
      expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toEqual([]);
      if (workerDecisions === 1) steering.append({ steerId: "include-gpt", text: update });
      return reply({
        action: "invoke_capability", capabilityId: "search_articles",
        intent: workerDecisions === 1 ? originalObjective : updatedObjective,
        authoringObjective: workerDecisions === 1 ? "STALE_QUERY" : "Author a technology and GPT article query.",
      });
    }
    if (input.modelStep === "capability.controls") return reply({ action: "invoke_capability", controls: {} });
    if (input.modelStep === "tool_payload.raw") {
      expect(execute).not.toHaveBeenCalled();
      const message = (input.messages as ChatMessage[]).find(({ content }) => content.startsWith("Canonical runtime context:\n"));
      expect(message).toBeDefined();
      const context = JSON.parse(message!.content.slice("Canonical runtime context:\n".length));
      payloadContexts.push(context);
      expect(context).toMatchObject({
        worker: { callId: replacementCallId, parentCallId: callerCallId, objective: updatedObjective },
        dependencyResults: [{ resultRef: "result-1", producerCallId: firstWorkerCallId, roleId: "worker", outcome: "yielded" }],
      });
      expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toEqual([]);
      expect(JSON.stringify(input.messages)).not.toContain("STALE_QUERY");
      return { text: input.format ? JSON.stringify({ topic: "GPT" }) : "technology GPT articles", meta: {} };
    }
    if (input.modelStep === "worker.result") {
      workerResults += 1;
      return { text: finalOutput, meta: {} };
    }
    if (input.modelStep === "supervisor.response") return { text: finalOutput, meta: {} };
    throw new Error(`Unexpected model step ${input.modelStep}`);
  });
  const policy = resolveRequestExecutionPolicy("supervisor-worker-v1");
  const request = createTestRequestExecutionScopeWithCapabilities({
    requestId, sessionId: `${requestId}-session`, prompt: originalObjective,
    historyMessages: [], shouldGenerateSessionTitle: false, runnerConfig, modelPolicy,
    agentMode: "reasoning", toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal, requestSteering: steering,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined), onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
    modelGatewayClient: { invoke: separateSupervisorRunnerModelPhases(invoke, { planner: ".", worker: "." }), invokeRaw: vi.fn() },
  }, (view) => createRequestWorkerCapabilityProvider({
    request: view, executionPolicyAuthority: policy.authority, toolRegistryOverride: registry,
  }), { executionPolicy: policy });

  await expect(runRequestRunner(request)).resolves.toEqual({ output: finalOutput });
  expect(workerDecisions).toBe(2);
  expect(workerResults).toBe(1);
  expect(plannerDecisions).toBe(caller === "planner" ? 3 : 0);
  expect(rootDecisions).toBe(caller === "supervisor" ? 3 : 2);
  expect(payloadContexts).toHaveLength(staged ? 2 : 1);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0]).toMatchObject({
    tool: "fixture_search", params: { query: "technology GPT articles", ...(staged ? { selection: '{"topic":"GPT"}' } : {}) },
  });
});
