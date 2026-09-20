import { expect, vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";

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
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (modelInput) => {
    await input.beforeModel?.(modelInput, ++calls);
    const visible = JSON.stringify({
      messages: modelInput.messages,
      format: modelInput.format,
    });
    expect(visible).not.toContain("private-destination-");
    expect(visible).not.toContain("connectionId");
    expect(visible).not.toContain("host_id");
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
      if (input.policy === "execution-agent-v1")
        return {
          text: JSON.stringify({
            decision: {
              invocations: {
                invocation_1: {
                  disposition: "execute",
                  controls: { channel: input.channel },
                },
              },
            },
          }),
          meta: {},
        };
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
        ? directDecision(decisions, input.capabilityId)
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
  return { invoke, invokeRaw: vi.fn<ModelGatewayClient["invokeRaw"]>() };
}

function directDecision(index: number, capabilityId: string) {
  if (index === 1)
    return {
      action: "open_capability_scope",
      catalogGroupIds: ["fixture"],
      acknowledgement: "I will inspect the fixture.",
    };
  if (index === 2)
    return {
      action: "invoke_capability",
      capabilityId,
      intent: "Observe the requested fixture.",
      operationObjective: "Observe the requested fixture.",
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
  if (index === 4) return { action: "return_result" };
  expect(index).toBe(5);
  return { action: "respond" };
}
