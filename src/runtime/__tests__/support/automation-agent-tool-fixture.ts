import { vi } from "vitest";
import type { RegisteredToolNormalInvocation, ToolCall, ToolExecutionResult } from "../../../capabilities/tool-types.js";
import type { AutomationDraftRecord } from "../../automations/storage-records.js";
import type { ToolRegistry } from "../../ports.js";
import type { createSchedulerRuntimeFixture } from "./scheduler-runtime-fixture.js";
import { withSupervisorPreparation } from "./supervisor-model-phases.js";
import { workerEvidenceReply } from "./worker-evidence-script.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
type Studio = NonNullable<Fixture["application"]["services"]["automations"]>;
export type Policy = "execution-agent-v1" | "supervisor-worker-v1";
export const operation = { toolName: "identity_probe", operationId: "observe", contractVersion: 1 } as const;

export function probeTools(effect: "read_only" | "mutating" = "read_only") {
  const registration: RegisteredToolNormalInvocation = {
    toolName: operation.toolName,
    definition: { name: operation.toolName, routingCapability: "semantic_lookup",
      executionEffect: effect, catalogGroups: ["identity_probe"], params: {} },
    contract: { version: 1, operations: [{
      operationId: operation.operationId, summary: "Observe a bounded fixture",
      effect, approval: "request_policy",
      input: { type: "object", additionalProperties: false, properties: {}, required: [] },
    }] },
  };
  const execute = vi.fn(async (call: ToolCall): Promise<ToolExecutionResult> => ({
    ok: true, tool: call.tool, output: "Observed the fixture.", producedNewInformation: true,
  }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: (name) => name === registration.toolName ? registration.definition : undefined,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    execute,
  };
  return { registry, execute };
}

export function scriptToolUsingAgent(fixture: Fixture, policy: Policy) {
  let executionDecisions = 0;
  let supervisorDecisions = 0;
  let workerAssessments = 0;
  fixture.invoke.mockImplementation(withSupervisorPreparation(async (input) => {
    if (input.modelStep === "execution.decision") {
      const action = [
        { action: "open_capability_scope", catalogGroupIds: ["identity_probe"] },
        { action: "invoke_capability", capabilityId: operation.operationId,
          workingDirectory: "project" },
        { action: "respond" },
      ][executionDecisions++ % 3];
      return { text: JSON.stringify({ decision: action }), meta: {} };
    }
    if (input.modelStep === "supervisor.decision") {
      if (typeof input.format === "object" && input.format?.name === "supervisor_working_directory")
        return { text: JSON.stringify({ workingDirectory: "project" }), meta: {} };
      const action = supervisorDecisions++ % 2 === 0
        ? { action: "invoke_role", roleId: "worker", objective: "Observe the fixture.",
          workerCapabilityScope: { catalogGroupIds: ["identity_probe"] },
          acknowledgement: "I will inspect the fixture." }
        : { action: "respond" };
      return { text: JSON.stringify({ decision: action }), meta: {} };
    }
    if (input.modelStep === "worker.evidence")
      return workerEvidenceReply(input, workerAssessments++ % 2 === 0);
    if (input.modelStep === "worker.decision")
      return { text: JSON.stringify({ decision: { action: "invoke_capability",
        capabilityId: operation.operationId, intent: "Observe the fixture." } }), meta: {} };
    if (input.modelStep === "capability.controls")
      return { text: JSON.stringify({ decision: { action: "invoke_capability", controls: {} } }), meta: {} };
    if (input.modelStep === "worker.result")
      return { text: "The fixture was observed.", meta: {} };
    if (input.modelStep === "execution.response" || input.modelStep === "supervisor.response")
      return { text: `Observed via ${policy}.`, meta: {} };
    throw new Error(`unexpected_model_step:${String(input.modelStep)}`);
  }));
}

export async function addAgent(studio: Studio, draft: AutomationDraftRecord, title: string) {
  return studio.updateDraft(draft.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: draft.definition.body.id,
    index: draft.definition.body.children.length,
    nodeWithoutId: {
      kind: "agent", title, onFailure: "stop", modelProfileId: "scheduled-model",
      agentMode: "reasoning", roleInstructions: "Observe the selected tool.",
      prompt: "Use the selected operation and report its result.", inputs: {},
      tools: [{ operation, usage: "required" }], result: { kind: "text" },
    },
  });
}
