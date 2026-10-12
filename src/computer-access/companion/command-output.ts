import { join } from "node:path";
import { failureResult, readBoundedInteger, successResult, type ToolImplementation,
  type ToolExecutionContext } from "../../plugin-sdk/index.js";
import { createSystemHandlers } from "../handlers.js";
import { createSystemOutputCapture } from "../command-output-capture.js";
import { DEFAULT_SYSTEM_OUTPUT_RETENTION_MS, scheduleSystemOutputCleanup } from "../command-output-retention.js";
import { runSystemProcess } from "../process-runner.js";
import { buildSystemProcessResult } from "../process-result.js";
import { isHostIdentifier } from "./protocol.js";
import { SYSTEM_OUTPUT_CAPABILITY, SYSTEM_OUTPUT_CHUNK_BYTES, readSystemOutputTransfer } from "./command-output-protocol.js";
import { redactSecretText } from "../security/secret-text.js";
import { systemResultProtection } from "../security/system-results.js";

type Capture = Awaited<ReturnType<typeof createSystemOutputCapture>>;

/** References belong to this authenticated connection; no arbitrary file access. */
export class CompanionCommandOutput {
  private readonly captures = new Map<string, Capture>();
  private closed = false;
  constructor(private readonly stateDir: string) {
    scheduleSystemOutputCleanup(join(stateDir, "command-output"), DEFAULT_SYSTEM_OUTPUT_RETENTION_MS);
  }
  hasTransfers(): boolean { return this.captures.size > 0; }
  close(): void {
    this.closed = true;
    for (const capture of this.captures.values()) capture.release();
    this.captures.clear();
  }
  handlers(): Record<string, ToolImplementation> {
    return {
      system_command_capture: (params, context) => this.command(params, context),
      system_command_output: async (params) => {
        try { return await this.read(params); }
        catch { return failureResult({ errorCode: "system_output_unavailable", message: "Retained command output is unavailable in this connection. The command was not replayed." }); }
      },
      system_command_output_close: async (params) => {
        if (!isHostIdentifier(params.captureId)) return failureResult({ errorCode: "system_output_reference_invalid", message: "Invalid output reference." });
        this.captures.get(params.captureId)?.release();
        this.captures.delete(params.captureId);
        return successResult({ output: "Output transfer closed; disk retention remains in effect." });
      },
    };
  }
  private async command(params: Record<string, unknown>, context?: ToolExecutionContext) {
    if (this.closed) return failureResult({ errorCode: "system_output_closed", message: "The connection closed before dispatch." });
    const retentionMs = readBoundedInteger(params.outputRetentionMs, {
      name: "outputRetentionMs", defaultValue: DEFAULT_SYSTEM_OUTPUT_RETENTION_MS,
      minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
    });
    let captured: Capture | undefined;
    const handlers = createSystemHandlers(undefined, undefined, () => ({
      run: async (input) => {
        if (input.abortSignal?.aborted) return runSystemProcess(input);
        captured = await createSystemOutputCapture(join(this.stateDir, "command-output"), retentionMs, redactSecretText);
        captured.retain();
        try {
          const result = await runSystemProcess(input, captured.capture);
          await captured.finish(result, false);
          return { ...captured.processResult!, outputTruncated: Boolean(captured.failure) };
        } catch (error) { await captured.finish(undefined, false); captured.release(); throw error; }
      },
      present: async (target, result) => {
        const receipt = buildSystemProcessResult(target, result, "command_process_completion");
        if (!captured?.receipt) return receipt;
        const data = { ...receipt.data, outputCapture: captured.receipt };
        if (captured.failure) {
          captured.release();
          const errorCode = captured.failureKind === "security" ? "system_output_protection_failed" : "system_output_storage_failed";
          return failureResult({ errorCode, message: "Command output could not be admitted after dispatch; inspect the process receipt before another action. The command was not replayed.",
            data: { ...data, ...(captured.failureKind === "security"
              ? { securityFailure: captured.failure } : { storageFailure: captured.failure }) },
            ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}) });
        }
        if (this.closed || context?.abortSignal?.aborted) {
          captured.release();
          return { ...receipt, data };
        }
        const transfer = readSystemOutputTransfer({ kind: SYSTEM_OUTPUT_CAPABILITY, ...captured.receipt });
        this.captures.set(transfer.id, captured);
        return { ...receipt, output: receipt.output.split("\nSTDOUT excerpt:")[0] + "\nSTDOUT excerpt:\nStreams retained for exact transfer.",
          data: { ...data, outputTransfer: transfer } };
      },
    }), systemResultProtection);
    const { outputRetentionMs: _retention, ...command } = params;
    try { return await handlers.system_command!(command, context); }
    finally {
      if (!this.hasRegisteredTransfer(captured)) captured?.release();
    }
  }
  private hasRegisteredTransfer(capture: Capture | undefined): boolean {
    const id = capture?.receipt?.id;
    if (!id) return false;
    return this.captures.get(id) === capture;
  }
  private async read(params: Record<string, unknown>) {
    if (!isHostIdentifier(params.captureId)) throw new Error("system_output_reference_invalid");
    const capture = this.captures.get(params.captureId);
    if (!capture?.receipt) throw new Error("system_output_reference_unknown");
    if (params.stream !== "stdout" && params.stream !== "stderr") throw new Error("system_output_stream_invalid");
    const stream = params.stream;
    const size = stream === "stdout" ? capture.receipt.stdoutBytes : capture.receipt.stderrBytes;
    const offset = readBoundedInteger(params.offset, { name: "offset", minimum: 0, maximum: size });
    const bytes = await capture.read(stream, offset, Math.min(SYSTEM_OUTPUT_CHUNK_BYTES, size - offset));
    return successResult({ output: "Private command-output chunk.", data: {
      captureId: params.captureId, stream, offset, bytes: bytes.toString("base64"),
    } });
  }
}
