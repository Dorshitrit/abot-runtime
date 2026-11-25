import { FILE_PAYLOAD_TOOL_REQUESTED } from "../capabilities/file-payload-tool-handoff.js";

/** Classifies recorded control flow without changing the receipt or write outcome. */
export function isFilePayloadToolRequest(event: Readonly<Record<string, unknown>>): boolean {
  if (event.error !== FILE_PAYLOAD_TOOL_REQUESTED) return false;
  if (event.name === "tool.payload.failed") return true;
  return event.name === "tool.failed" && event.stage === "before_external_execution";
}

export function isPayloadAuthoringFailureEvent(event: Readonly<Record<string, unknown>>): boolean {
  return event.name === "tool.payload.failed" && !isFilePayloadToolRequest(event);
}
