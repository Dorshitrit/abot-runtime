import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { deliverPluginTextResult, failureResult, type ToolExecutionContext,
  type ToolImplementationOutput } from "../../../src/plugin-sdk/index.js";
import { SYSTEM_OUTPUT_CAPABILITY, SYSTEM_OUTPUT_CHUNK_BYTES, readSystemOutputTransfer,
  type ComputerAccessConnection, type HostOperation } from "../../../src/plugin-sdk/computer-access.js";
import type { SystemRequestRoute } from "./request-target-snapshot.js";

type CompanionRoute = Extract<SystemRequestRoute, { kind: "companion" }>;
type Transfer = ReturnType<typeof readSystemOutputTransfer>;
type HostCall = (operation: HostOperation, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolImplementationOutput>;

export function supportsCompanionCommandOutput(route: CompanionRoute): boolean {
  return route.capabilities?.includes(SYSTEM_OUTPUT_CAPABILITY) === true;
}

/** Transfer is private adapter IO; the model receives one settled tool result. */
export async function executeCompanionCommand(input: {
  rootDir: string;
  route: CompanionRoute;
  connection: ComputerAccessConnection;
  params: Record<string, unknown>;
  outputRetentionMs?: number;
  context?: ToolExecutionContext;
}): Promise<ToolImplementationOutput> {
  const { route, context } = input;
  const call: HostCall = (operation, params, signal) => input.connection.executeHostOperation(input.rootDir, {
    hostId: route.hostId, connectionId: route.connectionId, operation,
    params: { ...params, target: route.target }, ...(signal ? { abortSignal: signal } : {}),
  });
  const receipt = await call("system_command_capture", {
    ...input.params, ...(input.outputRetentionMs !== undefined ? { outputRetentionMs: input.outputRetentionMs } : {}),
  }, context?.abortSignal);
  if (!receipt.data?.outputTransfer && !receipt.ok) return receipt;
  let transfer: Transfer | undefined;
  try {
    transfer = readSystemOutputTransfer(receipt.data?.outputTransfer);
    const stdout = await readStream(call, transfer, "stdout", context?.abortSignal);
    const stderr = await readStream(call, transfer, "stderr", context?.abortSignal);
    const { outputTransfer: _transfer, ...data } = receipt.data ?? {};
    const delivered = deliverPluginTextResult({ ...receipt, stdout, stderr: stderr || receipt.stderr,
      data: { ...data, outputDelivery: "complete", summaryOmittedChars: { stdout: stdout.length, stderr: stderr.length } },
    }, ["stdout", "stderr"], context?.resultBudget);
    if (delivered.errorCode === "plugin_result_too_large") return transferFailure(receipt, context);
    return delivered;
  } catch {
    return transferFailure(receipt, context);
  } finally {
    if (transfer) await call("system_command_output_close", { captureId: transfer.id }, AbortSignal.timeout(3_000)).catch(() => undefined);
  }
}

async function readStream(call: HostCall, transfer: Transfer, stream: "stdout" | "stderr", signal?: AbortSignal): Promise<string> {
  const size = stream === "stdout" ? transfer.stdoutBytes : transfer.stderrBytes;
  const digest = stream === "stdout" ? transfer.stdoutSha256 : transfer.stderrSha256;
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let text = "";
  for (let offset = 0; offset < size; offset += SYSTEM_OUTPUT_CHUNK_BYTES) {
    signal?.throwIfAborted();
    const part = await call("system_command_output", { captureId: transfer.id, stream, offset }, signal);
    if (!part.ok) throw new Error("system_output_transfer_failed");
    const data = part.data;
    if (data?.captureId !== transfer.id || data.stream !== stream || data.offset !== offset) throw new Error("system_output_chunk_binding_invalid");
    if (typeof data.bytes !== "string" || data.bytes.length > SYSTEM_OUTPUT_CHUNK_BYTES * 2) throw new Error("system_output_chunk_invalid");
    const bytes = Buffer.from(data.bytes, "base64");
    if (bytes.toString("base64") !== data.bytes) throw new Error("system_output_chunk_invalid");
    if (bytes.length !== Math.min(SYSTEM_OUTPUT_CHUNK_BYTES, size - offset)) throw new Error("system_output_chunk_size_invalid");
    hash.update(bytes);
    text += decoder.write(bytes);
  }
  if (hash.digest("hex") !== digest) throw new Error("system_output_digest_invalid");
  return text + decoder.end();
}

function transferFailure(receipt: ToolImplementationOutput, context?: ToolExecutionContext): ToolImplementationOutput {
  return failureResult({ errorCode: "system_output_delivery_pending",
    message: "The command settled, but its retained output could not be delivered completely. Process receipt is preserved; the command was not replayed.",
    ...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
    data: { ...receipt.data, outputDelivery: "pending", commandOk: receipt.ok, commandErrorCode: receipt.errorCode ?? null },
  }, context?.resultBudget);
}
