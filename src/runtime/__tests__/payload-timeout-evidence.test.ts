import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { projectWorkerAdapters } from "../adapters/registered-tool-worker-capabilities/execution.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { createRoleCapabilityBinding, type WorkerCapabilityDescriptor, type WorkerCapabilityPayloadAuthor } from "../orchestration/worker-capabilities/index.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { buildRequestToolResultsMessage, projectRequestToolResults } from "../context/request-tool-results.js";
import { buildExecutionCapabilityResultMessage } from "../steps/execution-agent/capability-result-context.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

const REQUEST_ID = "payload-timeout-evidence";
const SUMMARY = "Payload generation timed out after 90000 ms. No tool action was executed.";
const FRESHNESS = { token: { kind: "request_steering_v1" as const, version: 0, updates: [] }, isCurrent: () => true };
type Mode = "ordinary" | "staged" | "ea_file";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function fixture(mode: Mode) {
  const controls: WorkerCapabilityDescriptor["controls"] = {
    type: "object", additionalProperties: false,
    properties: { path: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["path"],
  };
  const descriptor: WorkerCapabilityDescriptor = {
    capabilityId: "write_file", summary: "Write the accepted file.", effect: "mutation",
    requiresPayloadAuthoringObjective: true, controls,
  };
  const bindBody = vi.fn((body: string) => body);
  const registration: RegisteredToolNormalInvocation = {
    toolName: "write_file",
    definition: {
      name: "write_file", routingCapability: "filesystem_mutation", executionEffect: "mutating",
      params: { path: "string", content: "string" },
      payloadChannelSpec: { params: ["content"], outputParam: "content", generationMode: "raw_text",
        ...(mode === "staged" ? { stages: [{ outputParam: "content", promptHint: "Author the accepted body." }] } : {}) },
    },
    contract: { version: 1, operations: [{ operationId: "write_file", summary: descriptor.summary,
      effect: "mutating", approval: "request_policy", input: controls,
      payload: { kind: "raw_text", param: "content", instructions: "Author the complete content.", minBytes: 1, maxBytes: 4096 } }] },
    ...(mode === "ea_file" ? { adapter: { preparePayload: async () => ({
      authoringContract: "execution_file_v1", context: { path: "target.txt", mode: "create" }, bind: bindBody,
    }) } } : {}),
  };
  const execute = vi.fn();
  const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(async () => ({
    status: "failed", code: "payload_model_timed_out", timeoutMs: 90_000,
  }));
  const onEvent = vi.fn();
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: [registration], toolRegistry: { execute }, requestId: REQUEST_ID,
    abortSignal: new AbortController().signal, toolPermissionMode: "full_access",
    nextApprovalId: () => "unexpected-approval", onEvent,
  });
  const adapters = projectWorkerAdapters<{}>({
    operationIds: [descriptor.capabilityId], descriptors: [descriptor], executor, sharedState: {},
    diagnostic: { requestId: REQUEST_ID, operationIds: [descriptor.capabilityId] },
    payloadAuthor: { author }, allowRelatedArtifactLoading: false,
  });
  const authority = resolveRequestExecutionPolicy(mode === "ea_file" ? "execution-agent-v1" : "supervisor-worker-v1").authority;
  const ledger = createRoleCallLedger({ requestId: REQUEST_ID, policy: { authority,
    limits: { maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 8,
      maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536 } } });
  for (const command of [
    { authority: "runtime", type: "create_root" },
    ...(mode === "ea_file" ? [] : [{ authority: "active_role", type: "open_child",
      callerCallId: "call-1", roleId: "worker", objective: "Write the accepted file." }]),
  ]) {
    const committed = await ledger.apply({ expectedHead: ledger.current(), command });
    if (!committed.ok) throw new Error(committed.code);
  }
  const call = ledger.current().state.calls.find(({ callId }) => callId === ledger.current().state.activeCallId)!;
  const binding = createRoleCapabilityBinding({ requestId: REQUEST_ID, context: {}, call, ledger, adapters,
    ...(mode === "ea_file" ? { executionFreshness: FRESHNESS } : {}) });
  return { ledger, binding, call, author, execute, bindBody, onEvent };
}

test.each<Mode>(["ordinary", "staged", "ea_file"])(
  "%s timeout reaches the next decision and persisted ledger without executing the tool",
  async (mode) => {
    const f = await fixture(mode);
    await f.binding.execute({ capabilityId: "write_file", intent: "Write the requested file.",
      authoringObjective: "Author the accepted complete file content.", controls: { path: "target.txt" } });
    expect(f.author).toHaveBeenCalledOnce();
    const authorInput = f.author.mock.calls[0]![0];
    if (mode === "ea_file") expect(authorInput.preparedPayload?.authoringContract).toBe("execution_file_v1");
    else if (mode === "staged") expect(authorInput.stage).toMatchObject({ index: 1, count: 1, outputParam: "content" });
    else expect(authorInput.stage).toBeUndefined();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.bindBody).not.toHaveBeenCalled();
    expect(f.onEvent).toHaveBeenCalledWith("tool.payload.failed", expect.objectContaining({ error: "payload_model_timed_out" }));
    const original = f.ledger.current().state.capabilityExecutions[0]!;
    expect(original).toMatchObject({ status: "settled", outcome: "failed", observedEffect: "none", summary: SUMMARY,
      exactResult: { kind: "runtime_capability_rejection_v1", authority: "runtime", status: "rejected",
        stage: "before_external_execution", code: "payload_model_timed_out", message: SUMMARY } });

    // Durable ledger restoration is admitted only while another capability is parked.
    const currentCall = f.ledger.current().state.calls.find(({ callId }) => callId === f.call.callId)!;
    const parked = await f.ledger.apply({ expectedHead: f.ledger.current(), command: {
      authority: "active_role", type: "begin_capability_execution", callId: f.call.callId,
      invocationAttempt: currentCall.activationCount, capabilityId: "observe_next", declaredEffect: "observation",
      intent: "Observe the next source after the rejected write.", controlsJson: "{}",
      actionFingerprint: `sha256:${"a".repeat(64)}`,
    } });
    if (!parked.ok) throw new Error(parked.code);
    const checkpoint = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(f.ledger)));
    const restored = createRoleCallLedger({ requestId: REQUEST_ID, policy: checkpoint.policy, checkpoint });
    expect(restored.current().state.capabilityExecutions[0]).toEqual(original);
    const message = mode === "ea_file"
      ? buildExecutionCapabilityResultMessage(restored.current(), restored.current().state.capabilityExecutions[0]!)
      : buildRequestToolResultsMessage(projectRequestToolResults({ ledger: restored, head: restored.current(),
        modelStep: "worker.decision", callId: f.call.callId }));
    const capsule = JSON.parse(message.content);
    const result = mode === "ea_file" ? capsule.result : capsule.results[0];
    expect(result).toMatchObject({ outcome: "failed", observedEffect: "none", summary: SUMMARY,
      adapterResult: original.exactResult });
  },
);
