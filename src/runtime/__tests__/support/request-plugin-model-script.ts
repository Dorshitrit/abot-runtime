import { expect, vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";
import { workerEvidenceReply } from "./worker-evidence-script.js";
import { supervisorFormatName, withSupervisorPreparation } from "./supervisor-model-phases.js";

export type SnapshotPolicy = "supervisor-worker-v1" | "execution-agent-v1";
export type SnapshotModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
export const SNAPSHOT_FINAL = "The fixture observation completed.";

export function createSnapshotModelScript(input: {
  policy: SnapshotPolicy;
  capabilityId: string;
  channel: string;
  beforeModel?: (
    input: SnapshotModelInput,
    index: number,
  ) => Promise<void> | void;
}) {
  let decisions = 0;
  let calls = 0;
  const respond = withSupervisorPreparation(async (modelInput) => {
    if (supervisorFormatName(modelInput) === "supervisor_basket_selection")
      return { text: JSON.stringify({ decision: { action: "continue" } }), meta: {} };
    const visible = JSON.stringify({
      messages: modelInput.messages,
      format: modelInput.format,
    });
    if (modelInput.modelStep === "worker.evidence")
      return workerEvidenceReply(modelInput, decisions < 3);
    if (modelInput.modelStep === "worker.result")
      return { text: SNAPSHOT_FINAL, meta: {} };
    if (modelInput.modelStep === "supervisor.response")
      return {
        text: modelInput.format
          ? JSON.stringify({ memoryCandidates: [] })
          : SNAPSHOT_FINAL,
        meta: {},
      };
    if (modelInput.modelStep === "execution.response")
      return { text: SNAPSHOT_FINAL, meta: {} };
    if (modelInput.modelStep === "capability.controls") {
      expect(visible).toContain(input.channel);
      expect(input.policy).toBe("supervisor-worker-v1");
      return {
        text: JSON.stringify({
          decision: {
            action: "invoke_capability",
            controls: { channel: input.channel },
          },
        }),
        meta: {},
      };
    }
    decisions += 1;
    const decision =
      input.policy === "execution-agent-v1"
        ? directDecision(decisions, input.capabilityId, input.channel)
        : delegatedDecision(decisions, input.capabilityId);
    if (
      modelInput.modelStep === "supervisor.decision" &&
      decisions === 2 &&
      input.policy === "supervisor-worker-v1"
    ) {
      return { text: JSON.stringify({ workingDirectory: "." }), meta: {} };
    }
    return { text: JSON.stringify({ decision }), meta: {} };
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (modelInput) => {
    await input.beforeModel?.(modelInput, ++calls);
    const visible = JSON.stringify({
      messages: modelInput.messages,
      format: modelInput.format,
    });
    expect(visible).not.toContain("private-destination-");
    expect(visible).not.toContain("connectionId");
    expect(visible).not.toContain("host_id");
    return respond(modelInput);
  });
  return { invoke, invokeRaw: vi.fn<ModelGatewayClient["invokeRaw"]>() };
}

function directDecision(index: number, capabilityId: string, channel: string) {
  if (index === 1)
    return {
      action: "open_capability_scope",
      catalogGroupIds: ["fixture"],
    };
  if (index === 2)
    return {
      action: "invoke_capability",
      capabilityId,
      selectionControls: { channel },
      workingDirectory: ".",
    };
  expect(index).toBe(3);
  return { action: "respond" };
}

function delegatedDecision(index: number, capabilityId: string) {
  if (index === 1)
    return {
      action: "invoke_role",
      roleId: "worker",
      objective: "Observe the requested fixture.",
      workerCapabilityScope: { catalogGroupIds: ["fixture"] },
      acknowledgement: "I will inspect the fixture.",
    };
  if (index === 2) return undefined;
  if (index === 3)
    return {
      action: "invoke_capability",
      capabilityId,
      intent: "Observe the requested fixture.",
    };
  expect(index).toBe(4);
  return { action: "respond" };
}
