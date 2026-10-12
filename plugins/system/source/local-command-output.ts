import { join } from "node:path";
import { deliverPluginTextResult, failureResult, readBoundedInteger, type RuntimePluginLoadContext,
  type ToolExecutionContext, type ToolImplementationOutput } from "../../../src/plugin-sdk/index.js";
import { buildSystemProcessResult, runSystemProcess, type SystemCommandOutputFactory,
  type SystemProcessResult, type SystemTarget } from "../../../src/plugin-sdk/computer-access.js";
import { createSystemOutputCapture, type SystemOutputReceipt } from "../../../src/plugin-sdk/computer-access.js";
import { DEFAULT_SYSTEM_OUTPUT_RETENTION_MS } from "../../../src/plugin-sdk/computer-access.js";
import { redactSecretText } from "./security/secret-text.js";
import { ensureWindowsOutputDirectory } from "./security/windows-output-directory.js";
import { scheduleLocalSystemOutputCleanup } from "./local-command-output-retention.js";

type Capture = Awaited<ReturnType<typeof createSystemOutputCapture>>;
const CONTEXT_STREAMS = Object.freeze(["stdout", "stderr"] as const);

export function createLocalSystemCommandOutput(plugin: RuntimePluginLoadContext): SystemCommandOutputFactory {
  const root = join(plugin.stateDir, "command-output");
  const retentionMs = systemCommandOutputRetentionMs(plugin);
  const initialization = scheduleLocalSystemOutputCleanup(root, retentionMs);
  return (context) => {
    let captured: Capture | undefined;
    return {
      async run(input) {
        if (input.abortSignal?.aborted) return runSystemProcess(input);
        await initialization;
        await ensureWindowsOutputDirectory(root);
        captured = await createSystemOutputCapture(root, retentionMs, redactSecretText);
        let result: SystemProcessResult;
        try { result = await runSystemProcess(input, captured.capture); }
        catch (error) { await captured.finish(); throw error; }
        const streams = await captured.finish(result);
        return { ...captured.processResult!, stdout: streams.stdout, stderr: streams.stderr,
          outputTruncated: Boolean(captured.failure) };
      },
      async present(target, result) {
        if (captured?.failure) return outputFailure(target, result, context, captured.receipt, captured.failure, captured.failureKind);
        const receipt = buildSystemProcessResult(target, result, "command_process_completion");
        const delivered = deliverPluginTextResult({ ...receipt,
          data: { ...receipt.data, ...(captured?.receipt ? { outputCapture: captured.receipt } : {}) } }, CONTEXT_STREAMS, context?.resultBudget);
        if (delivered.errorCode === "plugin_result_too_large")
          return outputFailure(target, result, context, captured?.receipt);
        return delivered;
      },
    };
  };
}

function outputFailure(target: SystemTarget, result: SystemProcessResult, context?: ToolExecutionContext,
  capture?: SystemOutputReceipt, captureFailure?: string, failureKind?: "security" | "storage"): ToolImplementationOutput {
  const failureCode = failureKind === "security" ? "system_output_protection_failed" : "system_output_storage_failed";
  return failureResult({
    errorCode: captureFailure ? failureCode : "system_output_delivery_pending",
    message: "The command was dispatched. Its output could not be delivered completely; do not repeat the command just to retrieve output. Inspect the process receipt and retained capture.",
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    data: { target: target.id, transport: target.transport, processStatus: result.status,
      spawnedProcess: result.spawnedProcess ?? null, exitCode: result.exitCode,
      outputCapture: capture ?? null,
      ...(captureFailure && failureKind === "security" ? { securityFailure: captureFailure } : {}),
      ...(captureFailure && failureKind !== "security" ? { storageFailure: captureFailure } : {}),
      outputDelivery: "pending", evidenceScope: "command_process_completion", independentOutcomeCheck: "not_performed",
      observationMeta: { kind: "volatile_external", carryPolicy: "never" } },
  }, context?.resultBudget);
}

export function systemCommandOutputRetentionMs(plugin: RuntimePluginLoadContext): number {
  return readBoundedInteger(plugin.config?.outputRetentionMs, {
    name: "outputRetentionMs", defaultValue: DEFAULT_SYSTEM_OUTPUT_RETENTION_MS,
    minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
  });
}
