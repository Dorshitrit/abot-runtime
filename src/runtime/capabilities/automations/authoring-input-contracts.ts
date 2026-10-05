import type { ToolNormalInvocationOperation } from "../../../capabilities/tool-types.js";

const id = { type: "string", minLength: 1, maxLength: 128 } as const;
const name = { type: "string", minLength: 1, maxLength: 64 } as const;
const positiveInteger = { type: "integer", minimum: 1, maximum: 2_147_483_647 } as const;
const node = { automationId: id, expectedRevision: positiveInteger, nodeId: id };
const requiredNode = ["automationId", "expectedRevision", "nodeId"];

/** Flat authoring conveniences project into the existing canonical draft mutation contract. */
export const automationAuthoringInputOperations = [
  {
    operationId: "bind_step_result",
    summary: "Bind one named agent input or tool control to an exact earlier step result, preserving other inputs. Select text or data explicitly; pointer is a JSON pointer for data only. Placement never passes outputs automatically. This does not set a tool payload; use set_tool_payload for that.",
    effect: "mutating", approval: "request_policy", fixedParams: { action: "bind_step_result" },
    input: { type: "object", additionalProperties: false,
      properties: { ...node, inputName: name, sourceNodeId: id,
        select: { type: "string", enum: ["text", "data"] },
        pointer: { type: "string", minLength: 1, maxLength: 512 } },
      required: [...requiredNode, "inputName", "sourceNodeId", "select"] },
  },
  {
    operationId: "set_step_literal",
    summary: "Set one named agent input or tool control to a literal while preserving other inputs. valueJson is only the raw JSON value (string, number, boolean, null, array or object), without a binding wrapper, bounded to 4096 UTF-8 bytes. The Runtime constructs the literal binding.",
    effect: "mutating", approval: "request_policy", fixedParams: { action: "set_step_literal" },
    input: { type: "object", additionalProperties: false,
      properties: { ...node, inputName: name,
        valueJson: { type: "string", minLength: 1, maxLength: 4_096 } },
      required: [...requiredNode, "inputName", "valueJson"] },
  },
  {
    operationId: "select_agent_tool",
    summary: "Select one exact catalog operation for an agent and set usage to available or required. Updates the same exact reference without duplicating it, preserving other selections. Selection does not grant permission, publish or run the automation.",
    effect: "mutating", approval: "request_policy", fixedParams: { action: "select_agent_tool" },
    input: { type: "object", additionalProperties: false,
      properties: { ...node, toolName: name, operationId: name, contractVersion: positiveInteger,
        usage: { type: "string", enum: ["available", "required"] } },
      required: [...requiredNode, "toolName", "operationId", "contractVersion", "usage"] },
  },
] as const satisfies readonly ToolNormalInvocationOperation[];
