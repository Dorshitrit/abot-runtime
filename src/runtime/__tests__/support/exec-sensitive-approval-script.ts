import { expect, vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";
import type { ExecRequestPolicy } from "./exec-command-request-script.js";

export const EXEC_APPROVAL_FINAL = "The requested fixture actions settled.";
export type ApprovalScriptAction = Readonly<{
  capabilityId: string;
  controls: Readonly<Record<string, unknown>>;
}>;

export function createExecApprovalScript(
  policy: ExecRequestPolicy,
  actions: readonly ApprovalScriptAction[],
  catalogGroup: string,
) {
  let selectedActions = 0;
  let supervisorTurns = 0;
  let executionTurns = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "worker.result")
      return { text: EXEC_APPROVAL_FINAL, meta: {} };
    if (input.modelStep === "execution.response")
      return { text: EXEC_APPROVAL_FINAL, meta: {} };
    if (input.modelStep === "supervisor.response")
      return {
        text: input.format
          ? JSON.stringify({ memoryCandidates: [] })
          : EXEC_APPROVAL_FINAL,
        meta: {},
      };
    if (input.modelStep === "capability.controls") {
      const action = actions[selectedActions - 1];
      expect(action, "unexpected controls refinement").toBeDefined();
      const controls = action!.controls;
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
    if (input.modelStep === "supervisor.decision") {
      supervisorTurns += 1;
      if (supervisorTurns === 2)
        return { text: JSON.stringify({ workingDirectory: "." }), meta: {} };
      const decision =
        supervisorTurns === 1
          ? {
              action: "invoke_role",
              roleId: "worker",
              objective: "Perform the exact fixture actions.",
              workerCapabilityScope: { catalogGroupIds: [catalogGroup] },
              acknowledgement: "I will perform the fixture actions.",
            }
          : { action: "respond" };
      return { text: JSON.stringify({ decision }), meta: {} };
    }
    if (input.modelStep === "execution.decision") {
      executionTurns += 1;
      if (executionTurns === 1)
        return {
          text: JSON.stringify({
            decision: {
              action: "open_capability_scope",
              catalogGroupIds: [catalogGroup],
              acknowledgement: "I will perform the fixture actions.",
            },
          }),
          meta: {},
        };
    } else expect(input.modelStep).toBe("worker.decision");
    const action = actions[selectedActions];
    const decision = action
      ? {
          action: "invoke_capability",
          capabilityId: action.capabilityId,
          intent: "Perform the exact fixture action.",
          ...(policy === "execution-agent-v1"
            ? {
                ...(requiresAuthoredControls(action)
                  ? { operationObjective: "Perform the exact fixture action." }
                  : {}),
                ...(selectedActions === 0 ? { workingDirectory: "." } : {}),
              }
            : {}),
        }
      : {
          action: policy === "execution-agent-v1" ? "respond" : "return_result",
        };
    if (action) selectedActions += 1;
    return { text: JSON.stringify({ decision }), meta: {} };
  });
  return {
    invoke,
    invokeRaw: vi.fn<ModelGatewayClient["invokeRaw"]>(async () => {
      throw new Error("approval fixture must not call a raw or live model");
    }),
  };
}

function requiresAuthoredControls(action: ApprovalScriptAction): boolean {
  return Object.keys(action.controls).length > 0;
}
