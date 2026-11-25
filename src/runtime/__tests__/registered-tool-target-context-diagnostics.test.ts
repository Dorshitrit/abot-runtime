import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { createWorkerCapabilityBinding, type WorkerCapabilityPayloadAuthor } from "../orchestration/worker-capabilities/index.js";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import { buildWorkerDecisionInput } from "../steps/worker-decision/input.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createWorkerDecisionModelPolicy, createWorkerDecisionRunnerConfig } from "./support/worker-decision-model-fixture.js";
import { commit } from "./support/super-mixed-compaction-fixture.js";

let root: string;
beforeEach(async () => {
  configureDebugLogger({ enabled: false });
  root = await mkdtemp(join(tmpdir(), "payload-target-diagnostic-"));
});
afterEach(async () => { resetDebugLoggerConfig(); await rm(root, { recursive: true, force: true }); });

const registration: RegisteredToolNormalInvocation = {
  toolName: "selected_target_editor",
  definition: {
    name: "selected_target_editor", routingCapability: "filesystem_mutation", executionEffect: "mutating",
    params: { path: "string", instruction: "string", content: "string" },
    payloadChannelSpec: { params: ["content"], outputParam: "content", generationMode: "raw_text",
      targetParam: "path", targetContext: "full_numbered", stages: [{ outputParam: "content" }] },
  },
  contract: { version: 1, operations: [{ operationId: "revise_selected_target", summary: "Revise the selected existing file.",
    effect: "mutating", approval: "request_policy",
    input: { type: "object", additionalProperties: false,
      properties: { path: { type: "string", minLength: 1, maxLength: 256 }, instruction: { type: "string", minLength: 1, maxLength: 256 } },
      required: ["path", "instruction"] },
    payload: { kind: "raw_text", param: "content", instructions: "Return the revised file.", minBytes: 1, maxBytes: 4096 },
  }] },
};

test("a missing target settles before external execution and reaches the next Worker input with exact reason and target", async () => {
  const requestId = "target-read-diagnostic";
  const objective = "Revise the selected existing file.";
  const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>();
  const execute = vi.fn<ToolRegistry["execute"]>();
  const onEvent = vi.fn();
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition], listNormalInvocations: () => [registration],
    getDefinition: name => name === registration.toolName ? registration.definition : undefined,
    hasToolsAvailable: () => true, getImplementations: () => ({}), execute,
    prepareSharedState: state => ({ ...state, runtimePaths: { agentWorkDir: root } }),
  };
  const provider = createRegisteredToolWorkerCapabilityProvider({ getRequestToolRegistry: () => registry,
    requestId, sessionId: "target-read-session", abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access", nextApprovalId: () => "unused", payloadAuthor: { author }, onEvent });
  const ledger = createRoleCallLedger({ requestId, policy: { limits: { maxDepth: 4, maxCalls: 8,
    maxCapabilityExecutions: 8, maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536 } } });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, { authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker", objective });
  const call = ledger.current().state.calls.at(-1)!;
  const binding = createWorkerCapabilityBinding({ requestId, ledger, call, context: {}, adapters: provider.getAdapters() });
  await expect(binding.execute({ capabilityId: "revise_selected_target", intent: objective, authoringObjective: objective,
    controls: { path: "missing.txt", instruction: objective } })).resolves.toEqual({ executionId: "capability-execution-1" });
  expect(author).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  const head = ledger.current();
  expect(head.state.capabilityExecutions).toHaveLength(1);
  const receipt = head.state.capabilityExecutions[0]!;
  expect(receipt).toMatchObject({ outcome: "failed", observedEffect: "none", exactResult: {
    kind: "runtime_capability_rejection_v1", stage: "before_external_execution", code: "payload_target_context_missing",
  } });
  expect(receipt.summary).toContain('"missing.txt"');
  expect(receipt.summary).toContain("does not exist");
  expect(receipt.summary).not.toContain(root);
  expect(onEvent).toHaveBeenCalledWith("tool.payload.failed", expect.objectContaining({
    executionId: receipt.executionId, error: "payload_target_context_missing" }));
  const resumed = head.state.calls.find(entry => entry.callId === call.callId)!;
  const nextBinding = createWorkerCapabilityBinding({ requestId, ledger, call: resumed, context: {}, adapters: provider.getAdapters() });
  const input = buildWorkerDecisionInput({ requestId, prompt: objective, historyMessages: [], agentMode: "reasoning",
    runnerConfig: createWorkerDecisionRunnerConfig(), modelPolicy: createWorkerDecisionModelPolicy(32_000) }, {
    call: resumed, requestToolResults: projectRequestToolResults({ ledger, head, callId: call.callId, modelStep: "worker.decision" }),
    capabilitySource: { ledger, head, binding: nextBinding }, capabilityResume: { ledger, head, executionId: receipt.executionId },
  });
  const visible = input.context.messages.flatMap(({ content }) => {
    try { return [JSON.parse(content)]; } catch { return []; }
  }).find(capsule => capsule.kind === "runtime_request_tool_results_v1");
  expect(visible.results[0].adapterResult).toEqual(receipt.exactResult);
  expect(input.availableCapabilityIds).toEqual(["revise_selected_target"]);
  expect(ledger.current()).toBe(head);
});
