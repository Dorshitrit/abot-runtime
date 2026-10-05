import type { ToolEventPresentation } from "../../../capabilities/tool-types.js";

/** Use the same declared call fields and bounded result excerpt as plugin tools. */
export const AUTOMATION_TOOL_EVENT_PRESENTATION: ToolEventPresentation = {
  metadata: {
    automationAction: { param: "action", kind: "string" },
    automationId: { param: "automationId", kind: "string" },
    automationTitle: { param: "title", kind: "string" },
    expectedRevision: { param: "expectedRevision", kind: "number" },
    nodeId: { param: "nodeId", kind: "string" },
    agentId: { param: "agentId", kind: "string" },
    view: { param: "view", kind: "string" },
    offset: { param: "offset", kind: "number" },
    toolName: { param: "toolName", kind: "string" },
    operationId: { param: "operationId", kind: "string" },
  },
  resultMetadata: {
    outputPreview: { path: "output", kind: "preview" },
  },
};
