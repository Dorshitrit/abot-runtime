import { createRequestSteeringInbox } from "../request/request-steering.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ToolCallAdapter,
  ToolImplementation,
  ToolModuleDeclaration,
} from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import { createApprovalRunnerFixture } from "./support/request-approval-runner-fixture.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";
import {
  createSnapshotModelScript,
  type SnapshotPolicy,
} from "./support/request-plugin-model-script.js";

function requestFixture(policy: SnapshotPolicy) {
  const base = createApprovalRunnerFixture();
  const binding = vi.fn<NonNullable<ToolCallAdapter["executionBinding"]>>(async () => ({
    identity: "request-target:revision-1",
    requiresApproval: true,
    metadata: { destinationLabel: "Selected fixture" },
  }));
  const implementation = vi.fn<ToolImplementation>(async () => ({
    ok: true, output: "Selected fixture observed.", producedNewInformation: true,
  }));
  const module: ToolModuleDeclaration = {
    definition: {
      name: "dynamic_observe", routingCapability: "semantic_lookup",
      catalogGroups: ["fixture"],
    },
    normalInvocation: {
      version: 1,
      operations: [{
        operationId: "dynamic_observe",
        summary: "Observe the selected fixture.",
        effect: "read_only",
        approval: "request_policy",
        input: {
          type: "object", additionalProperties: false,
          properties: { channel: { type: "string", enum: ["selected"] } },
          required: ["channel"],
        },
      }],
    },
    adapter: { executionBinding: binding },
    implementation,
  };
  const registry = createConfiguredToolRegistry(undefined, [module]);
  const gateway = createSnapshotModelScript({
    policy, capabilityId: "dynamic_observe", channel: "selected",
  });
  const executionPolicy = resolveRequestExecutionPolicy(policy);
  const onEvent = vi.fn();
  const resolveApproval = vi.fn(async () => ({ kind: "awaiting_approval" as const }));
  const makeRequest = (requestSteering = base.requestSteering) => createTestRequestExecutionScopeWithCapabilities({
    ...base.makeRequest(),
    requestSteering,
    prompt: "Observe the selected fixture once.",
    toolPermissionMode: "full_plus",
    modelGatewayClient: gateway,
    approvalGate: { resolve: resolveApproval },
    onEvent,
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        unused: { provider: "local", model: "scripted", contextWindowTokens: 32_000 },
      },
      defaults: { profileId: "unused", steps: {} },
    },
    runnerConfig: {
      models: { defaults: { profileId: "unused", steps: {} } },
      context: {
        outputReserveTokens: 128, safetyReserveTokens: 64, attachmentReserveTokens: 32,
      },
      steps: Object.fromEntries([
        "execution.decision", "execution.response", "supervisor.decision",
        "supervisor.response", "worker.evidence", "worker.decision",
        "worker.result", "capability.controls",
      ].map((step) => [step, { timeoutMs: 20_000 }])),
    },
  }, (request) => createRequestWorkerCapabilityProvider({
    request, executionPolicyAuthority: executionPolicy.authority,
    toolRegistryOverride: registry,
  }), { executionPolicy });
  return { binding, implementation, gateway, onEvent, resolveApproval, makeRequest };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s respects tool-owned approval through the request runner",
  (policy) => {
    test.each([true, false])(
      "parks FULL+ and resumes the same registered action after approval=%s",
      async (approved) => {
        const f = requestFixture(policy);
        const request = f.makeRequest();
        expect(request.toolPermissionMode).toBe("full_plus");
        const waiting = await runRequestRunner(request, { durableApproval: true });
        if (waiting.kind !== "awaiting_approval") throw new Error("expected approval wait");
        expect(f.resolveApproval).toHaveBeenCalledOnce();
        expect(f.implementation).not.toHaveBeenCalled();
        expect(f.binding).toHaveBeenCalledOnce();
        expect(f.binding.mock.calls[0]![1]).toMatchObject({
          toolPermissionMode: "full_plus", sessionId: request.sessionId,
        });
        const entries = waiting.continuation.preparedGroup.entries;
        expect(entries).toHaveLength(1);
        const entry = entries[0]!;
        expect(entry.approvalRequest!.call).toEqual({
          tool: "dynamic_observe", params: { channel: "selected" },
        });
        expect(request.toolPermissionMode).toBe("full_plus");
        expect(request.workerCapabilities.executionContext.toolPermissionMode).toBe("full_plus");
        expect(f.onEvent.mock.calls.some(([name]) => name === "tool.started")).toBe(false);

        const persisted = JSON.parse(JSON.stringify(waiting.continuation));
        // Durable resume hydrates a new live inbox after the old request parks.
        const resumedSteering = policy === "supervisor-worker-v1"
          ? createRequestSteeringInbox({ requestId: request.requestId }) : undefined;
        for (const update of request.requestSteering!.snapshot().updates)
          resumedSteering?.append({ steerId: update.steerId, text: update.text });
        const resumedRequest = f.makeRequest(resumedSteering);
        const resumed = await runRequestRunner(resumedRequest, {
          durableApproval: true,
          continuation: persisted,
          decisions: [{
            approvalId: entry.approvalRequest!.approvalId,
            actionFingerprint: entry.actionFingerprint,
            decision: { approved },
          }],
        });
        expect(resumed.kind).toBe("completed");
        expect(f.resolveApproval).toHaveBeenCalledOnce();
        expect(f.binding).toHaveBeenCalledTimes(2);
        expect(f.implementation).toHaveBeenCalledTimes(approved ? 1 : 0);
        if (approved) {
          expect(f.implementation.mock.calls[0]![0]).toEqual({ channel: "selected" });
          expect(f.implementation.mock.calls[0]![1]?.executionAuthority).toEqual({
            toolPermissionMode: "full_plus", executionIdentity: "request-target:revision-1",
          });
        }
        expect(request.toolPermissionMode).toBe("full_plus");
        expect(resumedRequest.toolPermissionMode).toBe("full_plus");
        expect(resumedRequest.workerCapabilities.executionContext.toolPermissionMode).toBe("full_plus");
        expect(f.onEvent.mock.calls.filter(([name]) => name === "tool.started"))
          .toHaveLength(approved ? 1 : 0);
        expect(f.gateway.invoke.mock.calls.filter(([input]) =>
          input.modelStep === "capability.controls")).toHaveLength(
          policy === "supervisor-worker-v1" ? 1 : 0,
        );
        expect(f.gateway.invokeRaw).not.toHaveBeenCalled();
      },
    );
  },
);
