import { randomBytes } from "node:crypto";
import { FilePayloadToolHandoff } from "../../capabilities/file-payload-tool-handoff.js";

/** Invocation-local control signals; ordinary file content remains exact RAW text. */
export function createFilePayloadOutputProtocol() {
  const boundary = randomBytes(8).toString("hex");
  return Object.freeze({
    abortPrefix: `<<<ABORT ${boundary}>>>\n`,
    toolPrefix: `<<<TOOL ${boundary}>>>\n`,
    suffix: `\n<<<END ${boundary}>>>`,
  });
}

type FilePayloadOutputProtocol = ReturnType<typeof createFilePayloadOutputProtocol>;

export const FILE_PAYLOAD_OUTPUT_INSTRUCTIONS = [
  "To write, return only the exact RAW file body. Do not wrap file content in WRITE/END markers, markdown fences or a JSON envelope. Preserve all body bytes, including its final newline.",
  "If the supplied source or assignment is insufficient or inconsistent, you may abort without making the change or request an offered capability to obtain what you need. Never put a refusal or request for information in the write body.",
  "To decline, return outputProtocol.abortPrefix + a short reason + outputProtocol.suffix. A tool request uses the separately offered tool contract. Control frames must stand alone; only one optional final newline may follow their suffix.",
  "An empty RAW response means an intentional empty file or range deletion when the assignment permits it. If responseFormat is declared, only file content must match it.",
].join("\n");

/** The existing EA preparation catch turns this into a rejection before binding. */
export class FilePayloadAuthorDeclinedError extends Error {
  readonly code = "payload_author_declined";

  constructor(reason: string) {
    super(`File author declined: ${reason}`);
    this.name = "FilePayloadAuthorDeclinedError";
  }
}

export function parseFilePayloadOutput(text: string, protocol: FilePayloadOutputProtocol): string {
  if (!beginsFilePayloadControl(text)) {
    if (containsFrameBoundary(text, protocol)) throw new Error("payload_model_output_invalid");
    return text;
  }
  const framed = removeOptionalFinalNewline(text);
  const isAbort = framed.startsWith(protocol.abortPrefix);
  const isTool = framed.startsWith(protocol.toolPrefix);
  if (!isAbort && !isTool) throw new Error("payload_model_output_invalid");
  if (!framed.endsWith(protocol.suffix)) throw new Error("payload_model_output_invalid");
  const prefix = isAbort ? protocol.abortPrefix : protocol.toolPrefix;
  if (framed.length < prefix.length + protocol.suffix.length) throw new Error("payload_model_output_invalid");
  const body = framed.slice(prefix.length, -protocol.suffix.length);
  if (containsFrameBoundary(body, protocol)) throw new Error("payload_model_output_invalid");
  if (isTool) throw new FilePayloadToolHandoff(body);
  const reason = body.trim();
  if (!reason || reason.length > 1024) throw new Error("payload_model_output_invalid");
  throw new FilePayloadAuthorDeclinedError(reason);
}

function beginsFilePayloadControl(text: string): boolean {
  return /^<<<(?:ABORT|TOOL)(?:\s|$)/.test(text);
}

function containsFrameBoundary(body: string, protocol: FilePayloadOutputProtocol): boolean {
  return Object.values(protocol).some((marker) => body.includes(marker.trim()));
}

function removeOptionalFinalNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}
