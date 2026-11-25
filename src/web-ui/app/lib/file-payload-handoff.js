export const FILE_PAYLOAD_TOOL_REQUEST_LABEL = "Requested a tool before writing";

/** Presentation only: the original write has not executed or succeeded. */
export function isFilePayloadToolRequest(message) {
  const event = message?.toolActivity ?? message;
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (event.error !== "payload_author_tool_requested") return false;
  const name = event.eventName || event.name || event.rawType || event.type;
  if (name === "tool.payload.failed") return true;
  const beforeExecution = event.stage === undefined
    ? event.beforeExternalExecution === true
    : event.stage === "before_external_execution";
  return name === "tool.failed" && beforeExecution;
}
