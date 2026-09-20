import { expect, vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";

export type ExecRequestPolicy = "execution-agent-v1" | "supervisor-worker-v1";
export const EXEC_REQUEST_FINAL = "The exec verification attempt settled.";

function executionDecision(turn: number) {
  if (turn === 1)
    return {
      action: "open_capability_scope",
      catalogGroupIds: ["exec"],
      acknowledgement: "I will verify the project.",
    };
  if (turn === 2)
    return {
      action: "invoke_capability",
      capabilityId: "execute_command",
      intent: "Verify the project.",
      operationObjective: "Verify the project.",
      workingDirectory: ".",
    };
  expect(turn).toBe(3);
  return { action: "respond" };
}

function delegatedDecision(turn: number) {
  if (turn === 1)
    return {
      action: "invoke_role",
      roleId: "worker",
      objective: "Verify the project.",
      workerCapabilityScope: { catalogGroupIds: ["exec"] },
      acknowledgement: "I will verify the project.",
    };
  if (turn === 3)
    return {
      action: "invoke_capability",
      capabilityId: "execute_command",
      intent: "Verify the project.",
    };
  if (turn === 4) return { action: "return_result" };
  expect(turn).toBe(5);
  return { action: "respond" };
}

export function createExecRequestScript(
  policy: ExecRequestPolicy,
  command: string,
) {
  let decisions = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "worker.result")
      return { text: EXEC_REQUEST_FINAL, meta: {} };
    if (input.modelStep === "execution.response")
      return { text: EXEC_REQUEST_FINAL, meta: {} };
    if (input.modelStep === "supervisor.response")
      return {
        text: input.format
          ? JSON.stringify({ memoryCandidates: [] })
          : EXEC_REQUEST_FINAL,
        meta: {},
      };
    if (input.modelStep === "capability.controls") {
      const controls = { command, cwd: "." };
      const decision =
        policy === "execution-agent-v1"
          ? {
              invocations: {
                invocation_1: { disposition: "execute", controls },
              },
            }
          : { action: "invoke_capability", controls };
      return { text: JSON.stringify({ decision }), meta: {} };
    }
    decisions += 1;
    const isDelegatedDirectorySelection =
      policy === "supervisor-worker-v1" && decisions === 2;
    if (isDelegatedDirectorySelection)
      return {
        text: JSON.stringify({ workingDirectory: "." }),
        meta: {},
      };
    const decision =
      policy === "execution-agent-v1"
        ? executionDecision(decisions)
        : delegatedDecision(decisions);
    return { text: JSON.stringify({ decision }), meta: {} };
  });
  return {
    invoke,
    invokeRaw: vi.fn<ModelGatewayClient["invokeRaw"]>(async () => {
      throw new Error("exec regression must not invoke a live or raw model");
    }),
  };
}
