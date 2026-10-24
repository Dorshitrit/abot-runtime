import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../../capabilities/tool-types.js";
import type { ModelGatewayClient, ToolRegistry } from "../../ports.js";
import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import type { WorkerSettledCapabilityResult } from "../../orchestration/worker-capabilities/contracts.js";
import { resolveRequestExecutionPolicy } from "../../request/role-executor-composition.js";
import { createRequestWorkerCapabilityProvider } from "../../request/worker-capability-composition.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";

export const OBSERVED_CONTENT = "exact collected source: <button id=chosen-control>";
export const INCIDENTAL_CONTENT = "unselected incidental file content";
export const CURRENT_TARGET_CONTENT = "selected target first line\nkeep this line\n";
export type ArtifactPolicyId = "execution-agent-v1" | "supervisor-worker-v1";

const stringControl = { type: "string" as const, minLength: 1, maxLength: 4096 };
const ROOT_CALL: RoleCallFrame = Object.freeze({
  callId: "call-1", parentCallId: null, roleId: "supervisor", depth: 0,
  objective: null, dependencyResultRefs: [], status: "active",
  childCallIds: [], activationCount: 2, resultRef: null,
});

export async function createPayloadArtifactPolicyFixture(
  root: string,
  policyId: ArtifactPolicyId,
  staged: boolean,
) {
  await writeFile(join(root, "needed.txt"), OBSERVED_CONTENT);
  await writeFile(join(root, "incidental.txt"), INCIDENTAL_CONTENT);
  await writeFile(join(root, "target.txt"), CURRENT_TARGET_CONTENT);
  const registrations = [readerRegistration(), writerRegistration(staged)];
  const definitions = registrations.map(({ definition }) => definition);
  const registry: ToolRegistry = {
    listDefinitions: () => definitions,
    listNormalInvocations: () => registrations,
    getDefinition: (name) => definitions.find((definition) => definition.name === name),
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    prepareSharedState: (state = {}) => ({
      ...state, runtimePaths: { rootDir: root, agentWorkDir: root },
    }),
    execute: async (call) => {
      if (call.tool === "fixture_reader") {
        return { ok: true, tool: call.tool,
          output: await readFile(join(root, String(call.params.path)), "utf8"),
          progress: true, producedNewInformation: true };
      }
      return { ok: true, tool: call.tool, output: "Committed selected file.",
        progress: true, producedNewInformation: true,
        actions: [{ type: "establish_target", target: String(call.params.path) }],
        data: { mutationEvidence: true } };
    },
  };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => ({
    text: input.format
      ? JSON.stringify({ placement: "replace", start_line: 1, end_line: 1 })
      : "authored replacement",
    meta: {},
  }));
  const policy = resolveRequestExecutionPolicy(policyId);
  const request = createTestRequestExecutionScope({
    requestId: "artifact-policy-request", sessionId: "artifact-policy-session",
    prompt: "Use the requested source for the selected file.",
    historyMessages: [], shouldGenerateSessionTitle: false,
    agentMode: "reasoning", toolPermissionMode: "full_access",
    modelPolicy: {
      defaults: { profileId: "fixture", steps: {} },
      providers: { local: { type: "ollama" } },
      profiles: { fixture: { provider: "local", model: "same-injected-model",
        contextWindowTokens: 64000 } },
    },
    runnerConfig: {
      models: { defaults: { profileId: "fixture", steps: {} } },
      context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
      steps: { "tool_payload.raw": { timeoutMs: 5000 } },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: { getDescriptors: () => [], getAdapters: () => [] },
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(), onEvent: vi.fn(),
  }, { executionPolicy: policy });
  const provider = createRequestWorkerCapabilityProvider({
    request, executionPolicyAuthority: policy.authority, toolRegistryOverride: registry,
  });
  const reader = provider.getAdapters().find(({ descriptor }) =>
    descriptor.capabilityId === "observe_source")!;
  const observed = await reader.execute({
    context: request.workerCapabilities.executionContext, call: ROOT_CALL,
    executionId: "capability-execution-2", intent: "Read the needed source.",
    controls: { path: "needed.txt" }, settledCapabilityResults: [],
  });
  if (observed.outcome !== "succeeded" || !observed.exactResult) {
    throw new Error("fixture_observation_failed");
  }
  const selectedEvidence: WorkerSettledCapabilityResult = {
    executionId: "capability-execution-2", callId: ROOT_CALL.callId, invocationAttempt: 2,
    capabilityId: "observe_source", declaredEffect: "observation",
    outcome: observed.outcome, observedEffect: observed.observedEffect,
    summary: observed.summary, references: observed.references,
    adapterResult: observed.exactResult,
  };
  await writeFile(join(root, "needed.txt"), "DISK_CHANGED_AFTER_OBSERVATION");
  const writer = provider.getAdapters().find(({ descriptor }) =>
    descriptor.capabilityId === "author_file")!;
  return {
    invoke, selectedEvidence,
    write: () => writer.execute({
      context: request.workerCapabilities.executionContext,
      call: { ...ROOT_CALL, activationCount: 3 },
      executionId: "capability-execution-3", intent: "Author the selected file.",
      authoringObjective: "Use the supplied exact source to author the selected file.",
      controls: staged ? { path: "target.txt", instruction: "Replace the first line." }
        : { path: "new.txt" },
      settledCapabilityResults: [incidentalReceipt(), selectedEvidence],
      executionFreshness: {
        token: { kind: "request_steering_v1", version: 0, updates: [] },
        isCurrent: () => true,
      },
    }),
  };
}

function incidentalReceipt(): WorkerSettledCapabilityResult {
  return {
    executionId: "capability-execution-1", callId: ROOT_CALL.callId, invocationAttempt: 1,
    capabilityId: "earlier_action", declaredEffect: "mutation",
    outcome: "succeeded", observedEffect: "mutation", summary: "Earlier artifact created.",
    references: [{ kind: "tool_target", target: "incidental.txt" }],
    adapterResult: { kind: "generic_capability_result_v1", authority: "capability_adapter",
      status: "executed", ok: true, payload: { receipt: "Earlier artifact created." } },
  };
}

function readerRegistration(): RegisteredToolNormalInvocation {
  return {
    toolName: "fixture_reader",
    definition: { name: "fixture_reader", routingCapability: "filesystem_inspection",
      params: { path: "string" } },
    contract: { version: 1, operations: [{
      operationId: "observe_source", summary: "Read an explicitly chosen source.",
      selectionControlIds: ["path"],
      input: { type: "object", additionalProperties: false,
        properties: { path: stringControl }, required: ["path"] },
      effect: "read_only", approval: "request_policy",
    }] },
  };
}

function writerRegistration(staged: boolean): RegisteredToolNormalInvocation {
  return {
    toolName: "fixture_writer",
    definition: { name: "fixture_writer", routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      params: { path: "string", content: "string", ...(staged
        ? { instruction: "string" as const, selection: "string" as const } : {}) },
      payloadChannelSpec: {
        params: staged ? ["selection", "content"] : ["content"],
        outputParam: "content", generationMode: "raw_text", targetParam: "path",
        targetRole: "operation_target", contextScope: "target_with_artifacts",
        ...(staged ? { groundingWindow: 1, stages: [
          { outputParam: "selection", contextScope: "target_only" as const,
            targetContext: "full_numbered" as const,
            responseFormat: { type: "object", properties: {
              placement: { type: "string" }, start_line: { type: "integer" },
              end_line: { type: "integer" } },
              required: ["placement", "start_line", "end_line"] },
            targetLineBoundProperties: ["start_line", "end_line"],
            promptHint: "Select the current first line." },
          { outputParam: "content", contextScope: "target_with_artifacts" as const,
            targetContext: "bounded" as const, includeMaterializedParams: ["selection"],
            promptHint: "Write the replacement." },
        ] } : {}),
      } },
    contract: { version: 1, operations: [{
      operationId: "author_file", summary: "Author the selected file.",
      input: { type: "object", additionalProperties: false,
        properties: { path: stringControl, ...(staged
          ? { instruction: stringControl, selection: stringControl } : {}) },
        required: staged ? ["path", "instruction", "selection"] : ["path"] },
      payload: { kind: "raw_text", param: "content", instructions: "Return raw content.",
        minBytes: 1, maxBytes: 4096 },
      effect: "mutating", approval: "request_policy",
    }] },
  };
}
