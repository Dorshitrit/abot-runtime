import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../../capabilities/tool-types.js";
import type { ModelGatewayClient, ToolRegistry } from "../../ports.js";
import {
  createRoleCallLedger, ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH, ROLE_CALL_RESULT_MAX_LENGTH,
} from "../../orchestration/role-calls/index.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "../../orchestration/worker-capabilities/payload-source-provenance.js";
import { createWorkerCapabilityBinding, EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA } from "../../orchestration/worker-capabilities/index.js";
import { projectRoleSettledCapabilityResults } from "../../orchestration/worker-capabilities/settled-results.js";
import { createRequestWorkerCapabilityProvider } from "../../request/worker-capability-composition.js";
import { resolveRequestExecutionPolicy } from "../../request/role-executor-composition.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";

export const FULL_TARGET_SOURCE = Array.from({ length: 10 }, (_, index) =>
  `original-line-${index + 1}: café`,
).join("\r\n") + "\r\n";
export const INCIDENTAL_SOURCE = "unselected-file-secret-marker";
type PolicyId = "supervisor-worker-v1" | "execution-agent-v1";

export async function fullTargetContextFixture(
  root: string,
  policyId: PolicyId | undefined,
  staged = true,
) {
  await writeFile(join(root, "target.txt"), FULL_TARGET_SOURCE);
  await writeFile(join(root, "incidental.txt"), INCIDENTAL_SOURCE);
  const requestId = "full-target-request";
  const policy = resolveRequestExecutionPolicy(policyId ?? "supervisor-worker-v1");
  const ledger = createRoleCallLedger({ requestId, policy: {
    authority: policy.authority,
    limits: { maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 8,
      maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
      maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
      maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH },
  } });
  let applied = await ledger.apply({ expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" } });
  if (!applied.ok) throw Error(applied.code);
  if (policyId !== "execution-agent-v1") {
    applied = await ledger.apply({ expectedHead: ledger.current(), command: {
      authority: "active_role", type: "open_child", callerCallId: "call-1",
      roleId: "worker", objective: "Update the selected current lines only.",
    } });
    if (!applied.ok) throw Error(applied.code);
  }
  const firstHead = ledger.current();
  const firstCall = firstHead.state.calls.find(entry => entry.callId === firstHead.state.activeCallId)!;
  const earlier = createWorkerCapabilityBinding({ requestId, context: {}, ledger, call: firstCall,
    adapters: [{ descriptor: { capabilityId: "earlier_write", summary: "Create an unrelated fixture.",
      effect: "mutation", controls: EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA },
      execute: async () => {
        await writeFile(join(root, "incidental.txt"), INCIDENTAL_SOURCE);
        return { outcome: "succeeded", observedEffect: "mutation", summary: "An earlier artifact exists.",
          references: [{ kind: "tool_target", target: "incidental.txt" }] };
      } }],
  });
  await earlier.execute({ capabilityId: "earlier_write", intent: "Create an unrelated fixture.", controls: {} });
  const head = ledger.current();
  const call = head.state.calls.find(entry => entry.callId === head.state.activeCallId)!;
  const assignmentProvenance = call.roleId === "worker"
    ? projectWorkerCapabilityPayloadSourceProvenance({ ledger, head, call }) : undefined;
  const settledCapabilityResults = projectRoleSettledCapabilityResults({ ledger, head, call });
  if (settledCapabilityResults.length !== 1 || settledCapabilityResults[0]?.outcome !== "succeeded") {
    throw Error("full_target_fixture_prior_capability_not_settled");
  }
  const registration = targetRegistration(staged);
  const execute = vi.fn<ToolRegistry["execute"]>(async toolCall => ({
    ok: true, tool: toolCall.tool, output: "Committed the selected change.",
    progress: true, producedNewInformation: true,
    data: { mutationEvidence: true },
    actions: [{ type: "refine_target", target: String(toolCall.params.path) }],
  }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: name => name === registration.toolName ? registration.definition : undefined,
    hasToolsAvailable: () => true, getImplementations: () => ({}), execute,
    prepareSharedState: (state = {}) => ({ ...state,
      runtimePaths: { rootDir: root, agentWorkDir: root } }),
  };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async input => ({
    text: input.format ? JSON.stringify({ placement: "replace", start_line: 4, end_line: 5 })
      : "new authored lines", meta: {},
  }));
  const request = createTestRequestExecutionScope({
    requestId, sessionId: "full-target-session", prompt: "Update the selected target.",
    historyMessages: [], shouldGenerateSessionTitle: false,
    agentMode: "reasoning", toolPermissionMode: "full_access",
    modelPolicy: { defaults: { profileId: "fixture", steps: {} },
      providers: { local: { type: "ollama" } },
      profiles: { fixture: { provider: "local", model: "injected-model", contextWindowTokens: 64000 } } },
    runnerConfig: { models: { defaults: { profileId: "fixture", steps: {} } },
      context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
      steps: { "tool_payload.raw": { timeoutMs: 5000 } } },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: { getDescriptors: () => [], getAdapters: () => [] },
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  }, { executionPolicy: policy });
  const provider = createRequestWorkerCapabilityProvider({ request,
    ...(policyId ? { executionPolicyAuthority: policy.authority } : {}),
    toolRegistryOverride: registry });
  const adapter = provider.getAdapters()[0]!;
  return {
    invoke, execute,
    run: async () => {
      const result = await adapter.execute({
      context: request.workerCapabilities.executionContext, call,
      ...(assignmentProvenance ? { assignmentProvenance } : {}),
      executionId: "capability-execution-2", intent: "Update the selected target.",
      authoringObjective: "Replace the selected lines and preserve every other line.",
      controls: staged ? { path: "target.txt", instruction: "Replace lines four and five." }
        : { path: "new.txt" },
      settledCapabilityResults,
      ...(call.roleId === "worker" ? {} : { executionFreshness: {
        token: { kind: "request_steering_v1" as const, version: 0, updates: [] },
        isCurrent: () => true,
      } }),
      });
      if (result.outcome !== "succeeded") throw Error(JSON.stringify(result));
      return result;
    },
  };
}

function targetRegistration(staged: boolean): RegisteredToolNormalInvocation {
  const string = { type: "string" as const, minLength: 1, maxLength: 4096 };
  return {
    toolName: "fixture_edit",
    definition: { name: "fixture_edit", routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      params: { path: "string", content: "string", ...(staged
        ? { instruction: "string" as const, selection: "string" as const } : {}) },
      payloadChannelSpec: { params: staged ? ["selection", "content"] : ["content"],
        outputParam: "content", generationMode: "raw_text", targetParam: "path",
        targetRole: "operation_target", contextScope: "target_with_artifacts",
        ...(staged ? { groundingWindow: 1, stages: [
          { outputParam: "selection", contextScope: "target_only" as const,
            targetContext: "full_numbered" as const,
            responseFormat: { type: "object", properties: {
              placement: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } },
              required: ["placement", "start_line", "end_line"] },
            targetLineBoundProperties: ["start_line", "end_line"], promptHint: "Select the exact range." },
          { outputParam: "content", contextScope: "target_with_artifacts" as const,
            targetContext: "bounded" as const, includeMaterializedParams: ["selection"],
            promptHint: "Author only the replacement for the selected range." },
        ] } : {}),
      } },
    contract: { version: 1, operations: [{ operationId: "update_target",
      summary: "Update the selected file.",
      input: { type: "object", additionalProperties: false,
        properties: { path: string, ...(staged ? { instruction: string, selection: string } : {}) },
        required: staged ? ["path", "instruction", "selection"] : ["path"] },
      payload: { kind: "raw_text", param: "content", instructions: "Return raw content.", minBytes: 1, maxBytes: 4096 },
      effect: "mutating", approval: "request_policy",
    }] },
  };
}
