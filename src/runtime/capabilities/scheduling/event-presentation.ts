import type { ToolEventPresentation } from "../../../capabilities/tool-types.js";

/** Display the accepted schedule operation without exposing its saved task prompt. */
export const SCHEDULING_TOOL_EVENT_PRESENTATION: ToolEventPresentation = {
  metadata: {
    scheduleAction: { param: "action", kind: "string", maxLength: 128 },
    scheduleJobId: { param: "jobId", kind: "string", maxLength: 200 },
    scheduleTitle: { param: "title", kind: "string", maxLength: 200 },
    scheduleKind: { param: "scheduleKind", kind: "string", maxLength: 32 },
  },
};
