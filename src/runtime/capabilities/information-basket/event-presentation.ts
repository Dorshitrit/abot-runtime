import type { ToolEventPresentation } from "../../../capabilities/tool-types.js";

/** Display names, counts and read coverage only; content remains solely in tool evidence. */
export const INFORMATION_BASKET_EVENT_PRESENTATION: ToolEventPresentation = {
  metadata: {
    basketAction: { param: "action", kind: "string" },
    basketSourceId: { param: "sourceId", kind: "string" },
  },
  resultMetadata: {
    basketSearchStatus: { path: "output", jsonPath: "status", kind: "preview" },
    documentName: { path: "output", jsonPath: "displayName", kind: "preview" },
    basketReadStartChar: { path: "output", jsonPath: "startChar", kind: "number" },
    basketReadEndChar: { path: "output", jsonPath: "endChar", kind: "number" },
    basketReadTotalCharacters: { path: "output", jsonPath: "totalCharacters", kind: "number" },
    documentName1: { path: "output", jsonPath: "sources.0.displayName", kind: "preview" },
    documentName2: { path: "output", jsonPath: "sources.1.displayName", kind: "preview" },
    documentName3: { path: "output", jsonPath: "sources.2.displayName", kind: "preview" },
    documentName4: { path: "output", jsonPath: "sources.3.displayName", kind: "preview" },
    documentName5: { path: "output", jsonPath: "sources.4.displayName", kind: "preview" },
    omittedDocumentCount: { path: "output", jsonPath: "omittedCount", kind: "number" },
  },
};
