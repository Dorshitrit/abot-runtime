import { vi } from "vitest";
import type { ToolModuleDeclaration } from "../../../capabilities/tool-types.js";
import { successResult } from "../../../plugin-sdk/index.js";
import type { AgentWorkRequest } from "../../agents/application-contracts.js";
import { createOrdinaryAgentSessionPort } from "../../agents/ordinary-session-port.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import { LocalRuntimeClientRequests } from "../../local-host/client-requests.js";
import { createLocalServiceClients } from "../../local-host/client-services.js";
import type { LocalRuntimePeer } from "../../local-host/contracts.js";
import type { ModelGatewayClient } from "../../ports.js";
import { createExecApprovalScript } from "./exec-sensitive-approval-script.js";
import { createSchedulerRuntimeFixture } from "./scheduler-runtime-fixture.js";

export async function createAgentOrdinaryOwnerFixture(policy: "execution-agent-v1" | "supervisor-worker-v1", approve = false) {
  const base = await createSchedulerRuntimeFixture(policy);
  await base.application.stop();
  const script = approve ? createExecApprovalScript(policy,
    [{ capabilityId: "record_agent_effect", controls: {} }], "agent_fixture") : base;
  const approvalScripts = new Map<string, ReturnType<typeof createExecApprovalScript>>();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    let requestScript = script;
    if (approve) {
      const id = input.debugRequestId ?? "fixture-request";
      let existing = approvalScripts.get(id);
      if (!existing) {
        existing = createExecApprovalScript(policy, [{ capabilityId: "record_agent_effect", controls: {} }], "agent_fixture");
        approvalScripts.set(id, existing);
      }
      requestScript = existing;
    }
    const result = await requestScript.invoke(input);
    // This fixture starts a fresh session, unlike the established-session script.
    if (input.modelStep === "execution.decision" && input.format && typeof input.format === "object") {
      const parsed = JSON.parse(result.text);
      if (schemaRequires(input.format.schema, "title")) parsed.decision.title = "Agent fixture work";
      if (schemaRequires(input.format.schema, "acknowledgement")) parsed.decision.acknowledgement = "I will perform the fixture task.";
      result.text = JSON.stringify(parsed);
    }
    return { ...result, meta: { ...result.meta, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } };
  });
  const execute = vi.fn(async () => successResult({ output: "The fixture effect completed." }));
  const module: ToolModuleDeclaration = {
    definition: { name: "agent_fixture_effect", routingCapability: "semantic_mutation", catalogGroups: ["agent_fixture"] },
    normalInvocation: { version: 1, operations: [{ operationId: "record_agent_effect", summary: "Record a fixture effect.",
      effect: "mutating", approval: "request_policy", input: { type: "object", additionalProperties: false, properties: {}, required: [] } }] },
    implementation: execute,
  };
  const owner = await createLocalRuntimeOwner(base.config, {
    models: { invoke, invokeRaw: script.invokeRaw }, tools: createConfiguredToolRegistry(base.config, [module]),
  });
  let client!: LocalRuntimeClientRequests;
  const peer: LocalRuntimePeer = { id: "agent-ordinary-view", callClient: (method, args) => client.handleCallback(method, args), onClose: () => () => {} };
  const call = vi.fn((method: string, args: readonly unknown[]) => owner.call(method, args, peer));
  client = new LocalRuntimeClientRequests(call);
  const unsubscribe = owner.subscribe((event) => client.receive(event));
  const sessions = createLocalServiceClients(call).sessions;
  const requests = { ...client.requests, approvalControls: { ...client.approvals, subscribeEvents: client.subscribe.bind(client) } };
  const port = createOrdinaryAgentSessionPort({ sessions, requests });
  const request: AgentWorkRequest = { agentId: "agent-a", missionId: "mission-a", attemptId: "attempt-a", requestId: "agent-work-a",
    sessionId: "agent-session-a", assignment: "Perform the fixture task.", modelProfileId: "scheduled-model", toolPermissionMode: "ask" };
  return { owner, port, request, call, sessions, invoke, execute, async dispose() {
    unsubscribe(); client.close(); await owner.stop(); await owner.whenIdle?.(); await base.dispose();
  } };
}

function schemaRequires(schema: unknown, field: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (Array.isArray(schema)) return schema.some((child) => schemaRequires(child, field));
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.required) && node.required.includes(field)) return true;
  return Object.values(node).some((child) => schemaRequires(child, field));
}
