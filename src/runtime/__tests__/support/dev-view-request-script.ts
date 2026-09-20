import { expect, vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";
import { isRecord } from "../../validation/strict-record.js";

export type DevViewRequestPolicy =
  | "execution-agent-v1"
  | "supervisor-worker-v1";
export const DEV_VIEW_REQUEST_FINAL = "The selected file section was read.";

const invocation = {
  action: "invoke_capability",
  capabilityId: "inspect_target",
  intent: "Read the requested section.",
  selectionControls: { path: "notes.txt" },
};

function rootDecision(turn: number) {
  if (turn === 1)
    return {
      action: "open_capability_scope",
      catalogGroupIds: ["read"],
      acknowledgement: "I will read the requested section.",
    };
  if (turn === 2)
    return {
      ...invocation,
      operationObjective: "Read the requested section containing target.",
      workingDirectory: ".",
    };
  if (turn === 3)
    return {
      ...invocation,
      operationObjective: "Read the second candidate's numeric window.",
    };
  expect(turn).toBe(4);
  return { action: "respond" };
}

function supervisorDecision(turn: number) {
  if (turn === 1)
    return {
      decision: {
        action: "invoke_role",
        roleId: "worker",
        objective: "Read the requested section.",
        workerCapabilityScope: { catalogGroupIds: ["read"] },
        acknowledgement: "I will read the requested section.",
      },
    };
  if (turn === 2) return { workingDirectory: "." };
  expect(turn).toBe(3);
  return { decision: { action: "respond" } };
}

export function createDevViewRequestScript(
  policy: DevViewRequestPolicy,
  guidance: string,
) {
  let rootTurns = 0;
  let workerTurns = 0;
  let controlsTurns = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "worker.result")
      return { text: DEV_VIEW_REQUEST_FINAL, meta: {} };
    if (input.modelStep === "execution.response")
      return { text: DEV_VIEW_REQUEST_FINAL, meta: {} };
    if (input.modelStep === "supervisor.response")
      return {
        text: input.format
          ? JSON.stringify({ memoryCandidates: [] })
          : DEV_VIEW_REQUEST_FINAL,
        meta: {},
      };
    if (input.modelStep === "capability.controls") {
      controlsTurns += 1;
      expect(containsSystemGuidance(input.messages, guidance)).toBe(true);
      const visible = JSON.stringify(input.messages);
      if (controlsTurns === 2) {
        expect(visible).toContain("ambiguous_text_locator");
        expect(visible).toContain("start_line=3, end_line=5");
      }
      const controls =
        controlsTurns === 1
          ? { locator: "target", context_lines: 1 }
          : { start_line: 3, end_line: 5 };
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
    if (input.modelStep === "supervisor.decision")
      return {
        text: JSON.stringify(supervisorDecision(++rootTurns)),
        meta: {},
      };
    if (input.modelStep === "worker.decision") {
      workerTurns += 1;
      const decision =
        workerTurns <= 2 ? invocation : { action: "return_result" };
      return { text: JSON.stringify({ decision }), meta: {} };
    }
    return {
      text: JSON.stringify({ decision: rootDecision(++rootTurns) }),
      meta: {},
    };
  });
  return {
    invoke,
    invokeRaw: vi.fn<ModelGatewayClient["invokeRaw"]>(async () => {
      throw new Error("Dev View fixture cannot invoke a live or raw model");
    }),
  };
}

function containsSystemGuidance(messages: unknown, guidance: string): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message: unknown) => {
    if (!isRecord(message)) return false;
    if (message.role !== "system") return false;
    if (typeof message.content !== "string") return false;
    return message.content.includes(guidance);
  });
}
