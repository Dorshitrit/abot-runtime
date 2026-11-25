/** EA file authoring control flow, transported through the existing result ledger. */
export const FILE_PAYLOAD_TOOL_HANDOFF = "execution_file_tool_handoff_v1";
export const FILE_PAYLOAD_TOOL_REQUESTED = "payload_author_tool_requested";

export class FilePayloadToolHandoff extends Error {
  readonly code = FILE_PAYLOAD_TOOL_REQUESTED;
  constructor(readonly selection: string) {
    super("File author requested a capability before continuing the accepted write.");
    this.name = "FilePayloadToolHandoff";
  }
}
