import { afterEach, expect, test, vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { directRespondText } from "./support/supervisor-direct-respond.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

const operation = { toolName: "save_brief", operationId: "save", contractVersion: 1 };
function writerFixture() {
  const registration: RegisteredToolNormalInvocation = {
    toolName: operation.toolName,
    definition: { name: operation.toolName, routingCapability: "semantic_mutation",
      executionEffect: "mutating", params: { content: "string" } },
    contract: { version: 1, operations: [{
      operationId: operation.operationId, summary: "Save the supplied brief",
      effect: "mutating", approval: "request_policy",
      input: { type: "object", additionalProperties: false,
        properties: { content: { type: "string", minLength: 1 } }, required: ["content"] },
    }] },
  };
  const execute = vi.fn(async () => ({ ok: true, tool: operation.toolName,
    output: "Saved", producedNewInformation: true }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition], listNormalInvocations: () => [registration],
    getDefinition: () => registration.definition, hasToolsAvailable: () => true,
    getImplementations: () => ({}), execute,
  };
  return { registry, execute };
}

test(
  "an explicit blocked agent decision prevents any dependent write",
  async () => {
    const tools = writerFixture();
    const f = await createSchedulerRuntimeFixture("execution-agent-v1", undefined, tools.registry);
    fixtures.push(f);
    f.invoke.mockImplementation(async (input) => {
      if (input.modelStep === "execution.decision" || input.modelStep === "supervisor.decision")
        return { text: JSON.stringify({ decision: { action: "blocked",
          acknowledgement: "I cannot complete this step.", response: "The requested evidence is unavailable." } }), meta: {} };
      throw new Error(`unexpected_model_step:${input.modelStep}`);
    });
    const studio = f.application.services.automations!;
    let draft = await studio.create("Blocked synthesis");
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
      nodeWithoutId: { kind: "agent", title: "Synthesize", onFailure: "stop",
        modelProfileId: "scheduled-model", agentMode: "fast", roleInstructions: "Synthesize evidence.",
        prompt: "Return the brief text.", inputs: {}, tools: [], result: { kind: "text" } },
    });
    const agentId = draft.definition.body.children[0]!.id;
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "add_node", parentSequenceId: draft.definition.body.id, index: 1,
      nodeWithoutId: { kind: "tool", title: "Save brief", onFailure: "stop", operation,
        controls: { content: { kind: "node_result", nodeId: agentId, select: "text" } } },
    });
    await studio.replaceGrant({ automationId: draft.automationId, expectedGrantRevision: 0,
      mode: "full_access", operations: [operation], actionId: "explicit-test-grant" });
    await studio.publish(draft.automationId, draft.revision);
    const run = await studio.runNow(draft.automationId);
    await expect.poll(async () => {
      const status = (await studio.getRun(run.id)).status;
      return ["pending", "running", "stopping"].includes(status) ? "active" : status;
    }, { timeout: 5_000, interval: 10 }).not.toBe("active");
    const result = await studio.getRun(run.id);
    expect(result).toMatchObject({ status: "failed", report: {
      outcome: "failed", nodeResults: [
        { nodeId: agentId, status: "failed", errorCode: "automation_agent_blocked" },
        { status: "cancelled" },
      ],
    } });
    expect(result.report?.nodeResults[0]).not.toHaveProperty("resultRef");
    expect(tools.execute).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenCalledOnce();
  },
  10_000,
);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s does not classify ordinary answer wording as a blocked disposition",
  async (policy) => {
    const tools = writerFixture();
    const f = await createSchedulerRuntimeFixture(policy, undefined, tools.registry);
    fixtures.push(f);
    const text = "The report discusses blocked requests and unavailable operations.";
    f.invoke.mockImplementation(async (input) => {
      if (input.modelStep === "supervisor.decision")
        return { text: directRespondText("I will return the requested text."), meta: {} };
      if (input.modelStep === "execution.decision")
        return { text: JSON.stringify({ decision: { action: "respond",
          acknowledgement: "I will return the requested text." } }), meta: {} };
      if (input.modelStep === "execution.response" || input.modelStep === "supervisor.response")
        return { text, meta: {} };
      throw new Error(`unexpected_model_step:${input.modelStep}`);
    });
    const studio = f.application.services.automations!;
    let draft = await studio.create("Literal response");
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
      nodeWithoutId: { kind: "agent", title: "Describe", onFailure: "stop",
        modelProfileId: "scheduled-model", agentMode: "fast", roleInstructions: "Describe outcomes.",
        prompt: "Return the requested description.", inputs: {}, tools: [], result: { kind: "text" } },
    });
    const agentId = draft.definition.body.children[0]!.id;
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "add_node", parentSequenceId: draft.definition.body.id, index: 1,
      nodeWithoutId: { kind: "tool", title: "Save response", onFailure: "stop", operation,
        controls: { content: { kind: "node_result", nodeId: agentId, select: "text" } } },
    });
    await studio.replaceGrant({ automationId: draft.automationId, expectedGrantRevision: 0,
      mode: "full_access", operations: [operation], actionId: "explicit-test-grant" });
    await studio.publish(draft.automationId, draft.revision);
    const run = await studio.runNow(draft.automationId);
    await expect.poll(async () => (await studio.getRun(run.id)).status,
      { timeout: 5_000, interval: 10 }).toBe("succeeded");
    const evidence = await studio.getStepEvidence(run.id, draft.definition.body.children[0]!.id, true);
    expect(JSON.stringify(evidence)).toContain(text);
    expect(tools.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ params: { content: text } }), expect.anything());
  },
  10_000,
);
