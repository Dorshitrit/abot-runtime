import { isHostIdentifier, isHostRecord } from "./protocol.js";

export const SYSTEM_OUTPUT_CAPABILITY = "system_command_output_v1";
/** Base64 plus receipts stay below both Companion and broker message limits. */
export const SYSTEM_OUTPUT_CHUNK_BYTES = 64 * 1024;
export type SystemOutputTransfer = Readonly<{
  kind: typeof SYSTEM_OUTPUT_CAPABILITY;
  id: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
}>;

function isStreamByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isStreamDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function readSystemOutputTransfer(value: unknown): SystemOutputTransfer {
  if (!isHostRecord(value)) throw new Error("system_output_receipt_invalid");
  if (value.kind !== SYSTEM_OUTPUT_CAPABILITY) throw new Error("system_output_receipt_invalid");
  if (!isHostIdentifier(value.id)) throw new Error("system_output_receipt_invalid");
  if (!isStreamByteCount(value.stdoutBytes)) throw new Error("system_output_receipt_invalid");
  if (!isStreamByteCount(value.stderrBytes)) throw new Error("system_output_receipt_invalid");
  if (!isStreamDigest(value.stdoutSha256)) throw new Error("system_output_receipt_invalid");
  if (!isStreamDigest(value.stderrSha256)) throw new Error("system_output_receipt_invalid");
  return { kind: SYSTEM_OUTPUT_CAPABILITY, id: value.id, stdoutBytes: value.stdoutBytes,
    stderrBytes: value.stderrBytes, stdoutSha256: value.stdoutSha256, stderrSha256: value.stderrSha256 };
}
